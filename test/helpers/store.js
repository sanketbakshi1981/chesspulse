'use strict';

const { Store } = require('../../src/store');

async function testStore() {
  if (process.env.TEST_POSTGRES !== '1') return new Store(':memory:');
  if (!process.env.PGHOST || !process.env.PGDATABASE?.endsWith('_test')) {
    throw new Error('PostgreSQL tests require PGHOST and a disposable PGDATABASE ending in _test.');
  }
  const store = await Store.open();
  await store.db.exec('TRUNCATE users, sessions, games, active_players, moves, quest_completions, guesses, xp_ledger, rating_changes');
  return store;
}

module.exports = { testStore };
