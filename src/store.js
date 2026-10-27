'use strict';

const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const RULES = require('./rules');
const { normalizeName } = require('./names');

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
    if (version > 1) throw new Error('Database schema is newer than this application.');
    if (version === 0) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL, salt TEXT NOT NULL, experience TEXT NOT NULL,
          external_rating INTEGER, rating INTEGER NOT NULL, xp INTEGER NOT NULL DEFAULT 0 CHECK(xp>=0),
          rated_games INTEGER NOT NULL DEFAULT 0, visible INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
        );
        CREATE TABLE games (id TEXT PRIMARY KEY, data TEXT NOT NULL, finished INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE active_players (
          user_id TEXT PRIMARY KEY REFERENCES users(id), game_id TEXT NOT NULL REFERENCES games(id)
        );
        CREATE TABLE moves (
          game_id TEXT NOT NULL REFERENCES games(id), ply INTEGER NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY(game_id,ply)
        );
        CREATE TABLE quest_completions (
          game_id TEXT NOT NULL REFERENCES games(id), user_id TEXT NOT NULL REFERENCES users(id),
          quest_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(game_id,user_id,quest_id)
        );
        CREATE TABLE guesses (
          game_id TEXT NOT NULL REFERENCES games(id), user_id TEXT NOT NULL REFERENCES users(id),
          quest_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(game_id,user_id,quest_id)
        );
        CREATE TABLE xp_ledger (
          game_id TEXT NOT NULL REFERENCES games(id), user_id TEXT NOT NULL REFERENCES users(id),
          data TEXT NOT NULL, PRIMARY KEY(game_id,user_id)
        );
        CREATE TABLE rating_changes (
          game_id TEXT NOT NULL REFERENCES games(id), user_id TEXT NOT NULL REFERENCES users(id),
          before INTEGER NOT NULL, after INTEGER NOT NULL, PRIMARY KEY(game_id,user_id)
        );
        PRAGMA user_version=1;
      `);
    });
  }

  transaction(fn) {
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

  user(id) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id); }
  byName(name) { return this.db.prepare('SELECT * FROM users WHERE name_key=?').get(name.toLowerCase()); }

  profile(user) {
    return {
      id: user.id, name: user.name, experience: user.experience,
      selfReportedRating: user.external_rating, rating: user.rating, xp: user.xp,
      ratedGames: user.rated_games, provisional: user.rated_games < RULES.provisionalGames,
      provisionalGames: RULES.provisionalGames,
      questRank: rank(user.xp), visible: Boolean(user.visible),
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
    if (this.byName(name)) throw new Error('That display name is already registered.');
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO users
      (id,name,name_key,password_hash,salt,experience,external_rating,rating,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, name, name.toLowerCase(), passwordHash, salt, experience, external, external ?? 1000, Date.now());
    return this.user(id);
  }

  async login({ name, password } = {}) {
    if (typeof name !== 'string' || typeof password !== 'string' || name.length > 100 || password.length > 128) {
      throw new Error('Invalid display name or password.');
    }
    const user = this.byName(name.trim());
    const derived = await scrypt(password, user?.salt || 'unknown-account-salt', 64);
    const expected = user ? Buffer.from(user.password_hash, 'hex') : Buffer.alloc(64);
    if (!crypto.timingSafeEqual(derived, expected) || !user) throw new Error('Invalid display name or password.');
    return user;
  }

  createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hashToken(token), userId, Date.now() + SESSION_MS);
    return token;
  }

  session(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    return this.db.prepare(`SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id
      WHERE token_hash=? AND expires_at>?`).get(hashToken(token), Date.now());
  }

  logout(token) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token)); }
  visibility(id, visible) { this.db.prepare('UPDATE users SET visible=? WHERE id=?').run(Number(visible), id); }
  saveGame(game) {
    const data = JSON.stringify({ ...game, chess: undefined });
    this.db.prepare(`INSERT INTO games(id,data,finished) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data,finished=excluded.finished`).run(game.id, data, Number(Boolean(game.result)));
  }
  loadGames() { return this.db.prepare('SELECT data FROM games').all().map((row) => JSON.parse(row.data)); }
  close() { this.db.close(); }
}

module.exports = { Store, SESSION_MS, hashToken, rank };
