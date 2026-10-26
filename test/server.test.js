'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../src/server');

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function emit(socket, event, data) {
  return new Promise((resolve) => socket.emit(event, data, resolve));
}

test('two players can check in, play and finish a game over sockets', async (t) => {
  const { httpServer, io, lobby } = createServer();
  lobby.randomColor = () => true; // challenger is white
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `http://localhost:${httpServer.address().port}`;
  const alice = ioClient(url, { transports: ['websocket'] });
  const bob = ioClient(url, { transports: ['websocket'] });
  t.after(() => {
    alice.close();
    bob.close();
    io.close();
  });
  await Promise.all([once(alice, 'connect'), once(bob, 'connect')]);

  assert.equal((await emit(alice, 'join', { name: 'Alice' })).name, 'Alice');
  const playersUpdate = once(alice, 'players');
  assert.equal((await emit(bob, 'join', { name: 'Bob' })).name, 'Bob');
  assert.deepEqual((await playersUpdate).map((p) => p.name), ['Alice', 'Bob']);
  assert.match((await emit(bob, 'join', { name: 'Bobby' })).error, /Already/);

  const incoming = once(bob, 'challenge:incoming');
  assert.deepEqual(await emit(alice, 'challenge', { to: bob.id }), { ok: true });
  assert.equal((await incoming).from.name, 'Alice');

  const starts = Promise.all([once(alice, 'game:start'), once(bob, 'game:start')]);
  await emit(bob, 'challenge:respond', { from: alice.id, accept: true });
  const [startA, startB] = await starts;
  assert.equal(startA.gameId, startB.gameId);
  assert.equal(startA.white.name, 'Alice');
  const { gameId } = startA;

  assert.match((await emit(bob, 'move', { gameId, from: 'e7', to: 'e5' })).error, /not your turn/);
  const update = once(bob, 'game:update');
  assert.deepEqual(await emit(alice, 'move', { gameId, from: 'e2', to: 'e4' }), { ok: true });
  assert.deepEqual((await update).moves, ['e4']);

  const over = once(alice, 'game:update');
  await emit(bob, 'resign', { gameId });
  const final = await over;
  assert.equal(final.result, '1-0');
  assert.equal(final.reason, 'resignation');
  assert.equal(lobby.games.size, 0);
});

test('disconnecting mid-game forfeits to the opponent', async (t) => {
  const { httpServer, io, lobby } = createServer();
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `http://localhost:${httpServer.address().port}`;
  const alice = ioClient(url, { transports: ['websocket'] });
  const bob = ioClient(url, { transports: ['websocket'] });
  t.after(() => {
    alice.close();
    bob.close();
    io.close();
  });
  await Promise.all([once(alice, 'connect'), once(bob, 'connect')]);
  await emit(alice, 'join', { name: 'Alice' });
  await emit(bob, 'join', { name: 'Bob' });
  const incoming = once(bob, 'challenge:incoming');
  await emit(alice, 'challenge', { to: bob.id });
  await incoming;
  const start = once(alice, 'game:start');
  await emit(bob, 'challenge:respond', { from: alice.id, accept: true });
  await start;

  const over = once(alice, 'game:update');
  bob.close();
  const final = await over;
  assert.equal(final.reason, 'opponent left');
  assert.equal(final.result, final.white.name === 'Alice' ? '1-0' : '0-1');
  assert.equal(lobby.players.size, 1);
});

test('serves the app, chess.js and the Stockfish engine files', async (t) => {
  const { httpServer, io } = createServer();
  await new Promise((resolve) => httpServer.listen(0, resolve));
  t.after(() => io.close());
  const base = `http://localhost:${httpServer.address().port}`;
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /ChessPulse/);
  const chess = await fetch(`${base}/vendor/chess.js`);
  assert.equal(chess.status, 200);
  assert.match(chess.headers.get('content-type'), /javascript/);
  const sfJs = await fetch(`${base}/vendor/stockfish/stockfish-19-lite-single.js`);
  assert.equal(sfJs.status, 200);
  const sfWasm = await fetch(`${base}/vendor/stockfish/stockfish-19-lite-single.wasm`, { method: 'HEAD' });
  assert.equal(sfWasm.status, 200);
  assert.equal(sfWasm.headers.get('content-type'), 'application/wasm');
});
