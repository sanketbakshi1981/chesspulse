'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { Lobby } = require('../src/lobby');
const { testStore } = require('./helpers/store');
const { PostgresDatabase } = require('../src/postgres');

async function withEnvironment(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { await fn(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('PostgreSQL requires complete configuration and verified production TLS', async () => {
  await withEnvironment({
    PGHOST: '127.0.0.1', PGDATABASE: 'chessquest_test', PGUSER: 'postgres',
    PGPASSWORD: 'local-test-password', PGSSLMODE: 'disable', NODE_ENV: 'production',
  }, async () => {
    await assert.rejects(PostgresDatabase.connect(), /TLS cannot be disabled/);
    await withEnvironment({ PGPASSWORD: '' }, async () => {
      await assert.rejects(PostgresDatabase.connect(), /PGPASSWORD is required/);
    });
    await withEnvironment({ PGHOST: '' }, async () => {
      await assert.rejects(Store.open(), /PGHOST is required/);
    });
    await withEnvironment({ PGSSLMODE: 'invalid' }, async () => {
      await assert.rejects(PostgresDatabase.connect(), /PGSSLMODE must be/);
    });
  });
});

test('PostgreSQL persists accounts, sessions, active games and finalization across reconnect', {
  skip: process.env.TEST_POSTGRES !== '1',
}, async () => {
  let store = await testStore();
  try {
    const alice = await store.register({ name: 'Alice', password: 'testing-password' });
    const bob = await store.register({ name: 'Bob', password: 'testing-password' });
    const token = await store.createSession(alice.id);
    let lobby = new Lobby(store, { randomColor: () => true });
    lobby.connect(alice.id, 'a');
    lobby.connect(bob.id, 'b');
    const { game } = await lobby.start(alice.id, bob.id);
    await lobby.act(alice.id, 'move', { gameId: game.id, version: 0, from: 'e2', to: 'e4' });
    await assert.rejects(Store.open(), /Another Chess Quest process/);
    await store.close();
    store = await Store.open();
    lobby = new Lobby(store);
    assert.equal((await store.session(token)).id, alice.id);
    assert.equal(await lobby.activeId(alice.id), game.id);
    assert.deepEqual((await lobby.game(game.id)).moves.map((move) => move.san), ['e4']);
    await lobby.act(bob.id, 'resign', { gameId: game.id });
    await store.close();
    store = await Store.open();
    lobby = new Lobby(store);
    assert.equal(await lobby.activeId(alice.id), undefined);
    assert.equal((await store.user(alice.id)).rating, 1016);
    assert.equal((await lobby.game(game.id)).recap.players.w.ratingDelta, 16);
    assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM rating_changes').get()).n, 2);
  } finally { await store.close(); }
});
