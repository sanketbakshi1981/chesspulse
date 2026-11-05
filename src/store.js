'use strict';

const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { AsyncLocalStorage } = require('node:async_hooks');
const RULES = require('./rules');
const { normalizeName } = require('./names');
const SCHEMA = require('./schema');

const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const rank = (xp) => `Level ${RULES.rankThresholds.filter((threshold) => xp >= threshold).length}`;

class Store {
  constructor(filename = process.env.DATABASE_PATH || path.join(__dirname, '../data/chessquest.sqlite')) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) throw new Error('Database schema is newer than this application.');
    if (version === 0) this.migrateSqlite(() => {
      this.db.exec(`${SCHEMA}\nPRAGMA user_version=2;`);
    });
    if (version === 1) this.migrateSqlite(() => {
      this.db.exec('ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0 CHECK(is_guest IN (0,1)); PRAGMA user_version=2;');
    });
  }

  static async open() {
    if (!process.env.PGHOST) {
      if (process.env.PGDATABASE || process.env.PGUSER || process.env.PGPASSWORD
        || process.env.WEBSITE_INSTANCE_ID || process.env.CONTAINER_APP_NAME) {
        throw new Error('PGHOST is required for PostgreSQL and Azure deployments.');
      }
      return new Store();
    }
    const { PostgresDatabase } = require('./postgres');
    const store = Object.create(Store.prototype);
    store.postgres = true;
    store.db = await PostgresDatabase.connect();
    store.db.exclusive = (fn) => store.exclusive(fn);
    try {
      await store.transaction(async () => {
        await store.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
        const row = await store.db.prepare('SELECT version FROM schema_version').get();
        if (row && ![1, 2].includes(row.version)) throw new Error('Unsupported PostgreSQL database schema version.');
        if (!row) {
          await store.db.exec(`${SCHEMA}\nINSERT INTO schema_version VALUES (2);`);
        } else if (row.version === 1) {
          await store.db.exec('ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0 CHECK(is_guest IN (0,1)); UPDATE schema_version SET version=2;');
        }
      });
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  exclusive(fn) {
    this.context ||= new AsyncLocalStorage();
    if (this.context.getStore() === this) return fn();
    const result = (this.pending || Promise.resolve()).then(() => this.context.run(this, fn));
    // Callers receive the rejection; a failed action must not poison the queue.
    this.pending = result.catch(() => {});
    return result;
  }

  async transaction(fn) {
    return this.exclusive(async () => {
      await this.db.exec(this.postgres ? 'BEGIN' : 'BEGIN IMMEDIATE');
      try {
        const result = await fn();
        await this.db.exec('COMMIT');
        return result;
      } catch (error) {
        await this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  migrateSqlite(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async user(id) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id); }
  async byName(name) { return this.db.prepare('SELECT * FROM users WHERE name_key=?').get(name.toLowerCase()); }
  async registeredPlayerCount() {
    return Number((await this.db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_guest=0').get()).count);
  }

  profile(user) {
    return {
      id: user.id, name: user.name, experience: user.experience, isGuest: Boolean(user.is_guest),
      selfReportedRating: user.external_rating, rating: user.rating, xp: user.xp,
      ratedGames: user.rated_games, provisional: !user.is_guest && user.rated_games < RULES.provisionalGames,
      provisionalGames: RULES.provisionalGames,
      questRank: rank(user.xp),
    };
  }

  async register({ name, password, experience = 'casual', rating } = {}) {
    const normalized = normalizeName(name);
    if (normalized.error) throw new Error(normalized.error);
    name = normalized.name;
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
      throw new Error('Password must contain 10–128 characters.');
    }
    if (!['beginner', 'casual', 'intermediate', 'advanced'].includes(experience)) throw new Error('Invalid experience.');
    const external = rating === '' || rating === undefined ? null : Number(rating);
    if (external !== null && (!/^\d+$/.test(String(rating)) || !Number.isInteger(external) || external < 100 || external > 3000)) {
      throw new Error('Rating must be a whole number from 100 to 3000, or blank.');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
    const id = crypto.randomUUID();
    return this.exclusive(async () => {
      if (await this.byName(name)) throw new Error('That display name is already registered.');
      await this.db.prepare(`INSERT INTO users
        (id,name,name_key,password_hash,salt,experience,external_rating,rating,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, name, name.toLowerCase(), passwordHash, salt, experience, external, external ?? 1000, Date.now());
      return this.user(id);
    });
  }

  async login({ name, password } = {}) {
    if (typeof name !== 'string' || typeof password !== 'string' || name.length > 100 || password.length > 128) {
      throw new Error('Invalid display name or password.');
    }
    const user = await this.byName(name.trim());
    const derived = await scrypt(password, user?.salt || 'unknown-account-salt', 64);
    const expected = user ? Buffer.from(user.password_hash, 'hex') : Buffer.alloc(64);
    if (!crypto.timingSafeEqual(derived, expected) || !user || user.is_guest) throw new Error('Invalid display name or password.');
    return user;
  }

  async guest({ name } = {}) {
    const normalized = normalizeName(name);
    if (normalized.error) throw new Error(normalized.error);
    name = normalized.name;
    return this.exclusive(async () => {
      if (await this.byName(name)) throw new Error('That display name is already in use. Choose another nickname.');
      const id = crypto.randomUUID();
      await this.db.prepare(`INSERT INTO users
        (id,name,name_key,password_hash,salt,experience,rating,created_at,is_guest)
        VALUES (?,?,?,?,?,?,?,?,1)`).run(id, name, name.toLowerCase(),
        crypto.randomBytes(64).toString('hex'), crypto.randomBytes(16).toString('hex'), 'casual', 1000, Date.now());
      return this.user(id);
    });
  }

  async createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    await this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hashToken(token), userId, Date.now() + SESSION_MS);
    return token;
  }

  async session(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    return this.db.prepare(`SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id
      WHERE token_hash=? AND expires_at>?`).get(hashToken(token), Date.now());
  }

  async logout(token) { await this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token)); }
  async saveGame(game) {
    const data = JSON.stringify({ ...game, chess: undefined });
    await this.db.prepare(`INSERT INTO games(id,data,finished) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data,finished=excluded.finished`).run(game.id, data, Number(Boolean(game.result)));
  }
  async loadGames() { return (await this.db.prepare('SELECT data FROM games').all()).map((row) => JSON.parse(row.data)); }
  async close() { await this.pending; await this.db.close(); }
}

module.exports = { Store, SESSION_MS, hashToken, rank };
