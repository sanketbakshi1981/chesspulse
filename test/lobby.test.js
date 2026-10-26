'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Lobby, normalizeName } = require('../src/lobby');

function lobbyWithGame() {
  const lobby = new Lobby({ randomColor: () => true }); // challenger plays white
  lobby.join('a', 'Alice');
  lobby.join('b', 'Bob');
  lobby.challenge('a', 'b');
  const { game } = lobby.respond('b', 'a', true);
  return { lobby, game };
}

test('normalizeName trims, collapses whitespace and validates', () => {
  assert.deepEqual(normalizeName('  Magnus   Carlsen '), { name: 'Magnus Carlsen' });
  assert.ok(normalizeName('').error);
  assert.ok(normalizeName('   ').error);
  assert.ok(normalizeName(42).error);
  assert.ok(normalizeName('x'.repeat(21)).error);
  assert.ok(normalizeName('<script>').error);
  assert.deepEqual(normalizeName("José O'Neil-2"), { name: "José O'Neil-2" });
});

test('join tracks online players and rejects duplicate names', () => {
  const lobby = new Lobby();
  assert.ok(lobby.join('a', 'Alice').player);
  assert.match(lobby.join('b', 'alice').error, /taken/);
  assert.ok(lobby.join('b', 'Bob').player);
  assert.match(lobby.join('a', 'Again').error, /Already/);
  assert.deepEqual(lobby.listPlayers(), [
    { id: 'a', name: 'Alice', status: 'idle' },
    { id: 'b', name: 'Bob', status: 'idle' },
  ]);
  lobby.leave('a');
  assert.deepEqual(lobby.listPlayers().map((p) => p.name), ['Bob']);
});

test('challenge validation', () => {
  const lobby = new Lobby();
  assert.match(lobby.challenge('a', 'b').error, /Check in/);
  lobby.join('a', 'Alice');
  assert.match(lobby.challenge('a', 'b').error, /no longer online/);
  assert.match(lobby.challenge('a', 'a').error, /yourself/);
  lobby.join('b', 'Bob');
  assert.ok(lobby.challenge('a', 'b').to);
  assert.match(lobby.respond('a', 'b', true).error, /no longer available/);
});

test('declining a challenge does not start a game', () => {
  const lobby = new Lobby();
  lobby.join('a', 'Alice');
  lobby.join('b', 'Bob');
  lobby.challenge('a', 'b');
  const res = lobby.respond('b', 'a', false);
  assert.equal(res.declined, true);
  assert.equal(lobby.games.size, 0);
  assert.match(lobby.respond('b', 'a', true).error, /no longer available/);
});

test('accepting a challenge starts a game and marks players busy', () => {
  const { lobby, game } = lobbyWithGame();
  assert.equal(game.white.id, 'a');
  assert.equal(game.black.id, 'b');
  assert.deepEqual(lobby.listPlayers().map((p) => p.status), ['playing', 'playing']);
  lobby.join('c', 'Carol');
  assert.match(lobby.challenge('c', 'a').error, /already in a game/);
  const state = Lobby.gameState(game);
  assert.equal(state.turn, 'w');
  assert.deepEqual(state.moves, []);
});

test('moves are validated for turn, legality and membership', () => {
  const { lobby, game } = lobbyWithGame();
  assert.match(lobby.move('b', game.id, { from: 'e7', to: 'e5' }).error, /not your turn/);
  assert.match(lobby.move('a', game.id, { from: 'e2', to: 'e5' }).error, /Illegal/);
  assert.match(lobby.move('x', game.id, { from: 'e2', to: 'e4' }).error, /not playing/);
  assert.match(lobby.move('a', 'nope', { from: 'e2', to: 'e4' }).error, /not found/);
  const res = lobby.move('a', game.id, { from: 'e2', to: 'e4' });
  assert.equal(res.move.san, 'e4');
  assert.deepEqual(Lobby.gameState(game).lastMove, { from: 'e2', to: 'e4', san: 'e4' });
  assert.equal(Lobby.gameState(game).turn, 'b');
});

test('checkmate ends the game and frees the players', () => {
  const { lobby, game } = lobbyWithGame();
  // Fool's mate: 1. f3 e5 2. g4 Qh4#
  for (const [p, from, to] of [
    ['a', 'f2', 'f3'],
    ['b', 'e7', 'e5'],
    ['a', 'g2', 'g4'],
    ['b', 'd8', 'h4'],
  ]) {
    assert.ok(!lobby.move(p, game.id, { from, to }).error);
  }
  assert.equal(game.result, '0-1');
  assert.equal(game.reason, 'checkmate');
  assert.deepEqual(lobby.listPlayers().map((p) => p.status), ['idle', 'idle']);
  assert.match(lobby.move('a', game.id, { from: 'a2', to: 'a3' }).error, /over/);
});

test('promotion defaults to queen and honours explicit choice', () => {
  const lobby = new Lobby({ randomColor: () => true });
  lobby.join('a', 'Alice');
  lobby.join('b', 'Bob');
  lobby.challenge('a', 'b');
  const { game } = lobby.respond('b', 'a', true);
  game.chess.load('8/P6k/8/8/8/8/8/K7 w - - 0 1');
  assert.equal(lobby.move('a', game.id, { from: 'a7', to: 'a8', promotion: 'n' }).move.san, 'a8=N');
});

test('resigning ends the game in favour of the opponent', () => {
  const { lobby, game } = lobbyWithGame();
  assert.match(lobby.resign('c', game.id).error, /not playing/);
  lobby.resign('b', game.id);
  assert.equal(game.result, '1-0');
  assert.equal(game.reason, 'resignation');
  assert.ok(lobby.resign('a', game.id).error);
});

test('leaving mid-game forfeits and clears challenges', () => {
  const { lobby, game } = lobbyWithGame();
  lobby.join('c', 'Carol');
  lobby.join('d', 'Dave');
  lobby.challenge('c', 'd');
  const res = lobby.leave('a');
  assert.equal(res.game, game);
  assert.equal(game.result, '0-1');
  assert.equal(game.reason, 'opponent left');
  const res2 = lobby.leave('d');
  assert.deepEqual(res2.cancelledChallengers, ['c']);
  assert.equal(lobby.challenges.size, 0);
  assert.deepEqual(lobby.leave('zzz'), {});
});
