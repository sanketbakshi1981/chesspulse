'use strict';

const { Client, types } = require('pg');

class PostgresDatabase {
  static async connect() {
    for (const name of ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
      if (!process.env[name]) throw new Error(`${name} is required for PostgreSQL.`);
    }
    if (!['verify-full', 'disable'].includes(process.env.PGSSLMODE || 'verify-full')) {
      throw new Error('PGSSLMODE must be verify-full, or disable for local testing only.');
    }
    if (process.env.NODE_ENV === 'production' && process.env.PGSSLMODE === 'disable') {
      throw new Error('PostgreSQL TLS cannot be disabled in production.');
    }
    const port = Number(process.env.PGPORT || 5432);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PGPORT.');
    const db = new PostgresDatabase();
    db.client = new Client({
      host: process.env.PGHOST,
      port,
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
      application_name: 'chessquest',
      types: {
        getTypeParser(oid, format) {
          if (oid !== 20) return types.getTypeParser(oid, format);
          return (value) => {
            const number = Number(value);
            if (!Number.isSafeInteger(number)) throw new Error('PostgreSQL integer exceeds the safe JavaScript range.');
            return number;
          };
        },
      },
    });
    db.client.on('error', (error) => {
      console.error('PostgreSQL connection failed:', error);
      process.exitCode = 1;
      process.kill(process.pid, 'SIGTERM');
    });
    try {
      await db.client.connect();
      const { rows } = await db.client.query('SELECT pg_try_advisory_lock(731927401) AS acquired');
      if (!rows[0].acquired) throw new Error('Another Chess Quest process owns this database. Run exactly one instance.');
      return db;
    } catch (error) {
      await db.client.end();
      throw error;
    }
  }

  prepare(sql) {
    let index = 0;
    const text = sql.replace(/\?/g, () => `$${++index}`);
    const query = (values) => this.exclusive(() => this.client.query(text, values));
    return {
      get: async (...values) => (await query(values)).rows[0],
      all: async (...values) => (await query(values)).rows,
      run: async (...values) => query(values),
    };
  }

  exec(sql) { return this.exclusive(() => this.client.query(sql)); }
  close() { return this.client.end(); }
}

module.exports = { PostgresDatabase };
