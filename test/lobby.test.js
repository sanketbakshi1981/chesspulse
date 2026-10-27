'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { Lobby, normalizeName } = require('../src/lobby');
const { CATALOG } = require('../src/quests');

async function fixture(t, options = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const alice = await store.register({ name: 'Alice', password: 'alice-password', rating: '1000' });
  const bob = await store.register({ name: 'Bob', password: 'bobby-password', rating: '1000' });
  let time = 1_800_000_000_000;
  const lobby = new Lobby(store, { now: () => time, randomColor: () => true, ...options });
  lobby.connect(alice.id, 'a');
  lobby.connect(bob.id, 'b');
  const start = () => {
    const { game, error } = lobby.start(alice.id, bob.id);
    assert.equal(error, undefined);
    return game;
  };
  const move = (id, gameId, from, to, extra = {}) => {
    const game = lobby.game(gameId);
    return lobby.act(id, 'move', { gameId, version: game.version, from, to, ...extra });
  };
  return { store, alice, bob, lobby, start, move, advance: (ms) => { time += ms; } };
}
function setQuest(store, lobby, gameId, color, questId) {
  const game = lobby.game(gameId);
  game.assignments[color] = [{ ...CATALOG.find((q) => q.questId === questId), completedAtPly: null, completedAt: null, evidence: null }];
  store.saveGame(game);
}
const sequence = ['g1f3', 'd7d6', 'f3e5', 'c8d7', 'e5d7', 'd8d7', 'e2e4', 'e7e5', 'f1c4', 'b8c6'];
function play(f, game, moves = sequence) {
  for (const [ply, uci] of moves.entries()) {
    const response = f.move(ply % 2 ? f.bob.id : f.alice.id, game.id, uci.slice(0, 2), uci.slice(2, 4));
    assert.equal(response.error, undefined, `${uci}: ${response.error}`);
  }
}

test('display names are normalized and validated', () => {
  assert.deepEqual(normalizeName('  Magnus   Carlsen '), { name: 'Magnus Carlsen' });
  for (const input of ['', 42, '<script>', 'x'.repeat(21)]) assert.ok(normalizeName(input).error);
});

test('persistent identity validates ratings, hashes passwords and derives provisional profile', async (t) => {
  const { store, alice } = await fixture(t);
  assert.notEqual(alice.password_hash, 'alice-password');
  assert.equal((await store.login({ name: 'alice', password: 'alice-password' })).id, alice.id);
  await assert.rejects(store.login({ name: 'Alice', password: 'incorrect' }), /Invalid/);
  await assert.rejects(store.register({ name: 'alice', password: 'alice-password' }), /registered/);
  for (const rating of ['99', '3001', '1200.5', 'hello', null]) {
    await assert.rejects(store.register({ name: 'New', password: 'valid-password', rating }), /Rating/);
  }
  const blank = await store.register({ name: 'New', password: 'valid-password', rating: '' });
  assert.equal(blank.rating, 1000);
  assert.equal(blank.external_rating, null);
  store.db.prepare('UPDATE users SET rated_games=5 WHERE id=?').run(alice.id);
  assert.equal(store.profile(store.user(alice.id)).provisional, false);
  const token = store.createSession(alice.id);
  assert.equal(store.session(token).id, alice.id);
  assert.notEqual(store.db.prepare('SELECT token_hash FROM sessions').get().token_hash, token);
  store.logout(token);
  assert.equal(store.session(token), undefined);
});

test('presence defaults private, handles multiple tabs, expiry and match availability', async (t) => {
  const f = await fixture(t);
  const { lobby, store, alice, bob } = f;
  assert.deepEqual(lobby.listPlayers(), []);
  store.visibility(alice.id, true);
  assert.equal(lobby.listPlayers().length, 1);
  lobby.connect(alice.id, 'a2');
  lobby.disconnect('a');
  assert.equal(lobby.presence(alice.id), 'online');
  f.start();
  assert.equal(lobby.listPlayers()[0].status, 'in_game');
  lobby.disconnect('a2');
  assert.equal(lobby.presence(alice.id), 'offline');
  assert.ok(lobby.activeId(alice.id), 'disconnect does not forfeit');
  f.advance(60_001);
  lobby.tick();
  assert.equal(lobby.presence(bob.id), 'offline');
});

test('queue expands by rating, pairs once, and challenge acceptance cannot duplicate games', async (t) => {
  const f = await fixture(t);
  const { lobby, store, alice, bob } = f;
  store.db.prepare('UPDATE users SET rating=1400 WHERE id=?').run(bob.id);
  lobby.enqueue(alice.id);
  lobby.enqueue(bob.id);
  assert.equal(lobby.pair().length, 0);
  f.advance(45_000);
  assert.equal(lobby.pair().length, 1);
  assert.equal(lobby.pair().length, 0);
  assert.ok(lobby.enqueue(alice.id).error);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM active_players').get().n, 2);
  const game = lobby.game(lobby.activeId(alice.id));
  assert.equal(game.timeControl, '10+0');
  assert.equal(game.assignments.w.length, 1);
  assert.equal(game.assignments.b.length, 1);
  assert.deepEqual(game.clocks, { w: 600_000, b: 600_000 });
  assert.ok(lobby.start(alice.id, alice.id).error);
});

test('direct hidden-player challenges and acceptance are single-use', async (t) => {
  const { lobby, alice, bob, store } = await fixture(t);
  assert.equal(lobby.challenge(alice.id, 'Bob').to.id, bob.id);
  assert.ok(lobby.respond(bob.id, alice.id, true).game);
  assert.ok(lobby.respond(bob.id, alice.id, true).error);
  assert.equal(store.loadGames().length, 1);
});

test('moves enforce participant, version, legal turn; clocks only charge running side', async (t) => {
  const f = await fixture(t);
  const game = f.start();
  assert.match(f.move(f.bob.id, game.id, 'e7', 'e5').error, /turn/);
  assert.match(f.move(f.alice.id, game.id, 'e2', 'e5').error, /Illegal/);
  assert.match(f.move('outsider', game.id, 'e2', 'e4').error, /not playing/);
  f.advance(2500);
  assert.ok(f.move(f.alice.id, game.id, 'e2', 'e4').ok);
  let saved = f.lobby.game(game.id);
  assert.deepEqual(saved.clocks, { w: 597_500, b: 600_000 });
  assert.match(f.lobby.act(f.alice.id, 'move', { gameId: game.id, version: 0, from: 'e2', to: 'e4' }).error, /Stale/);
  f.advance(3000);
  f.move(f.bob.id, game.id, 'e7', 'e5');
  saved = f.lobby.game(game.id);
  assert.deepEqual(saved.clocks, { w: 597_500, b: 597_000 });
  assert.equal(saved.moves.length, 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM moves').get().n, 2);
  const restored = new Lobby(f.store, { now: f.lobby.now });
  assert.equal(restored.snapshot(restored.game(game.id), f.alice.id).fen, saved.chess.fen());
  assert.equal(restored.activeId(f.alice.id), game.id);
});

test('snapshots never expose unguessed opponent assignments or guesses', async (t) => {
  const f = await fixture(t);
  const game = f.start();
  setQuest(f.store, f.lobby, game.id, 'w', 'E01');
  setQuest(f.store, f.lobby, game.id, 'b', 'H04');
  let snapshot = f.lobby.snapshot(f.lobby.game(game.id), f.alice.id);
  assert.equal(snapshot.ownQuests[0].questId, 'E01');
  assert.equal(JSON.stringify(snapshot).includes('H04'), false);
  assert.equal(snapshot.assignments, undefined);
  assert.equal(snapshot.recap, null);
  assert.equal(f.lobby.snapshot(game, 'outsider'), null);
  assert.ok(f.lobby.act(f.alice.id, 'guess', { gameId: game.id, questId: 'H04' }).ok);
  snapshot = f.lobby.snapshot(f.lobby.game(game.id), f.alice.id);
  assert.equal(snapshot.version, 1);
  assert.match(f.lobby.act(f.alice.id, 'move', { gameId: game.id, version: 0, from: 'e2', to: 'e4' }).error, /Stale/);
  assert.equal(snapshot.revealedQuests[0].questId, 'H04');
  assert.deepEqual(f.lobby.snapshot(f.lobby.game(game.id), f.bob.id).guesses, []);
});

test('guess attempts reject repeats, throttle, stop at two, and cannot complete quests', async (t) => {
  const f = await fixture(t);
  const game = f.start();
  setQuest(f.store, f.lobby, game.id, 'b', 'E02');
  assert.ok(f.lobby.act('outsider', 'guess', { gameId: game.id, questId: 'E02' }).error);
  assert.ok(f.lobby.act(f.alice.id, 'guess', { gameId: game.id, questId: 'E05' }).error);
  assert.ok(f.lobby.act(f.alice.id, 'guess', { gameId: game.id, questId: 'E02' }).ok);
  assert.match(f.lobby.act(f.alice.id, 'guess', { gameId: game.id, questId: 'E02' }).error, /already/);
  assert.match(f.lobby.act(f.alice.id, 'guess', { gameId: game.id, questId: 'E01' }).error, /second/);
  f.advance(1000);
  assert.match(f.lobby.act(f.alice.id, 'guess', { gameId: game.id, questId: 'E01' }).error, /Attempt used/);
  assert.match(f.lobby.act(f.alice.id, 'guess', { gameId: game.id, questId: 'H04' }).error, /remaining/);
  assert.equal(f.lobby.game(game.id).assignments.b[0].completedAtPly, null);
  assert.match(f.lobby.act(f.alice.id, 'completeQuest', { gameId: game.id, questId: 'E01' }).error, /Unknown/);
});

test('quest completion, guesses, XP rounding, independent Elo and finalization are reproducible', async (t) => {
  const f = await fixture(t);
  const game = f.start();
  setQuest(f.store, f.lobby, game.id, 'w', 'E01');
  setQuest(f.store, f.lobby, game.id, 'b', 'E02');
  f.lobby.act(f.alice.id, 'guess', { gameId: game.id, questId: 'E02' });
  f.lobby.act(f.bob.id, 'guess', { gameId: game.id, questId: 'E01' });
  play(f, game);
  const complete = f.lobby.game(game.id).assignments.w[0];
  assert.equal(complete.completedAtPly, 5);
  assert.equal(complete.evidence.san, 'Nxd7');
  const result = f.lobby.act(f.alice.id, 'resign', { gameId: game.id }).game;
  assert.equal(result.recap.players.w.total, 17);
  assert.equal(result.recap.players.b.total, 30);
  assert.equal(result.recap.players.w.ratingDelta, -16);
  assert.equal(result.recap.players.b.ratingDelta, 16);
  assert.equal(f.store.user(f.alice.id).xp, 17);
  assert.equal(f.store.user(f.alice.id).rating, 984);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM quest_completions').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM xp_ledger').get().n, 2);
  assert.ok(f.lobby.act(f.alice.id, 'resign', { gameId: game.id }).error);
  f.lobby.tick();
  assert.equal(f.store.user(f.alice.id).xp, 17);
  assert.equal(f.store.user(f.alice.id).rated_games, 1);
  assert.equal(f.lobby.history(f.alice.id)[0].gameId, game.id);
  const revealed = f.lobby.snapshot(result, f.alice.id).recap.players.b.quests[0].questId;
  assert.equal(revealed, 'E02');
});

test('completed objective guesses fail without revealing whether assigned', async (t) => {
  const f = await fixture(t);
  const game = f.start();
  setQuest(f.store, f.lobby, game.id, 'w', 'E01');
  play(f, game, sequence.slice(0, 5));
  const response = f.lobby.act(f.bob.id, 'guess', { gameId: game.id, questId: 'E01' });
  assert.match(response.error, /Attempt used/);
  const snapshot = f.lobby.snapshot(response.game, f.bob.id);
  assert.equal(snapshot.guesses[0].correct, false);
  assert.deepEqual(snapshot.revealedQuests, []);
});

test('server timeout wins, disconnected games continue, and early games earn no XP', async (t) => {
  const f = await fixture(t);
  const game = f.start();
  f.lobby.disconnect('a');
  f.advance(600_001);
  const [finished] = f.lobby.tick();
  assert.equal(finished.id, game.id);
  assert.equal(finished.result, '0-1');
  assert.equal(finished.reason, 'timeout');
  assert.deepEqual(finished.recap.flags, ['fewer than 10 plies']);
  assert.equal(finished.recap.players.w.total, 0);
  assert.equal(f.store.user(f.alice.id).rating, 984);
  assert.equal(f.lobby.activeId(f.alice.id), undefined);
});

test('checkmate and draw agreement use chess outcome, not quests; draw XP uses x1', async (t) => {
  const f = await fixture(t);
  let game = f.start();
  play(f, game, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
  assert.equal(f.lobby.game(game.id).reason, 'checkmate');
  game = f.start();
  setQuest(f.store, f.lobby, game.id, 'w', 'E01');
  play(f, game);
  assert.ok(f.lobby.act(f.alice.id, 'offerDraw', { gameId: game.id }).ok);
  assert.ok(f.lobby.act(f.alice.id, 'respondDraw', { gameId: game.id, accept: true }).error);
  const draw = f.lobby.act(f.bob.id, 'respondDraw', { gameId: game.id, accept: true }).game;
  assert.equal(draw.result, '1/2-1/2');
  assert.equal(draw.recap.players.w.multiplier, 1);
  assert.equal(draw.recap.players.w.total, 20);
});

test('threefold is claimable, fivefold is automatic, duplicate move versions are rejected', async (t) => {
  const f = await fixture(t);
  let game = f.start();
  const cycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
  play(f, game, [...cycle, ...cycle]);
  assert.equal(f.lobby.game(game.id).result, null);
  assert.equal(f.lobby.act(f.alice.id, 'claimDraw', { gameId: game.id }).game.reason, 'threefold repetition');
  game = f.start();
  play(f, game, [...cycle, ...cycle, ...cycle, ...cycle]);
  assert.equal(f.lobby.game(game.id).reason, 'fivefold repetition');
});

test('repeat-opponent cap prevents XP after three eligible games per UTC day', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) {
    const game = f.start();
    setQuest(f.store, f.lobby, game.id, 'w', 'E01');
    play(f, game);
    const result = f.lobby.act(f.bob.id, 'resign', { gameId: game.id }).game;
    assert.equal(result.recap.players.w.total, i < 3 ? 40 : 0);
    assert.equal(result.recap.xpEligible, i < 3);
  }
  assert.equal(f.store.user(f.alice.id).xp, 120);
  assert.equal(f.store.user(f.alice.id).rated_games, 4);
});

test('assignment config is limited to 1-2 valid enabled quests', async (t) => {
  const f = await fixture(t, { questCount: 2 });
  const game = f.start();
  assert.equal(new Set(game.assignments.w.map((q) => q.questId)).size, 2);
  assert.ok(game.assignments.w.every((q) => q.enabled));
  assert.throws(() => new Lobby(f.store, { questCount: 3 }), /QUEST_COUNT/);
  assert.throws(() => new Lobby(f.store, { questCount: 2, questLevel: 'Medium' }), /Not enough/);
});

test('reward transaction rolls back both players, game, quests and ledger on write failure', async (t) => {
  const f = await fixture(t);
  const game = f.start();
  setQuest(f.store, f.lobby, game.id, 'w', 'E01');
  play(f, game);
  f.store.db.exec(`CREATE TRIGGER fail_reward BEFORE INSERT ON rating_changes
    WHEN NEW.after > NEW.before BEGIN SELECT RAISE(ABORT, 'injected reward failure'); END;`);
  assert.throws(() => f.lobby.act(f.alice.id, 'resign', { gameId: game.id }), /injected/);
  assert.equal(f.store.user(f.alice.id).rating, 1000);
  assert.equal(f.store.user(f.bob.id).rating, 1000);
  assert.equal(f.store.user(f.alice.id).xp, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM xp_ledger').get().n, 0);
  assert.equal(f.lobby.game(game.id).result, null);
  assert.equal(f.lobby.activeId(f.alice.id), game.id);
  f.store.db.exec('DROP TRIGGER fail_reward;');
  assert.ok(f.lobby.act(f.alice.id, 'resign', { gameId: game.id }).ok);
  assert.equal(f.store.user(f.alice.id).xp, 10);
});

test('draw claims support an intended repetition move without adding it to history', async (t) => {
  const f = await fixture(t);
  const game = f.start();
  play(f, game, ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1']);
  const active = f.lobby.game(game.id);
  const response = f.lobby.act(f.bob.id, 'claimDraw', {
    gameId: game.id, version: active.version, from: 'f6', to: 'g8',
  });
  assert.equal(response.game.reason, 'threefold repetition');
  assert.equal(response.game.moves.length, 7);
  assert.equal(response.game.drawClaim.uci, 'f6g8');
});

test('server special moves include castling and en passant', async (t) => {
  const f = await fixture(t);
  let game = f.start();
  play(f, game, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'e1g1']);
  assert.equal(f.lobby.game(game.id).moves.at(-1).san, 'O-O');
  f.lobby.act(f.bob.id, 'resign', { gameId: game.id });
  game = f.start();
  setQuest(f.store, f.lobby, game.id, 'w', 'M08');
  play(f, game, ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6']);
  const saved = f.lobby.game(game.id);
  assert.equal(saved.chess.get('d5'), undefined);
  assert.equal(saved.assignments.w[0].completedAtPly, 5);
});

test('fifty/seventy-five move rules, stalemate and insufficient material are distinct', async (t) => {
  const f = await fixture(t);
  let game = f.start();
  game.chess.load('7k/8/8/8/8/8/R7/K7 w - - 100 51');
  assert.equal(f.lobby.apply(game, 'w', 'claimDraw', {}), null);
  assert.equal(game.reason, 'fifty-move rule');
  game = { ...game, result: null, reason: null };
  game.chess.load('7k/8/8/8/8/8/R7/K7 w - - 150 76');
  f.lobby.checkEnd(game);
  assert.equal(game.reason, 'seventy-five-move rule');
  game = { ...game, result: null, reason: null };
  game.chess.load('k7/8/1QK5/8/8/8/8/8 b - - 0 1');
  f.lobby.checkEnd(game);
  assert.equal(game.reason, 'stalemate');
  game = { ...game, result: null, reason: null };
  game.chess.load('7k/8/8/8/8/8/8/K7 w - - 0 1');
  f.lobby.checkEnd(game);
  assert.equal(game.reason, 'insufficient material');
});

test('timeout material distinguishes bare king, minor pieces and possible selfmates', async (t) => {
  const f = await fixture(t);
  const game = f.start();
  for (const [fen, canMate] of [
    ['7k/8/8/8/8/8/R7/K7 w - - 0 1', false],
    ['6nk/8/8/8/8/8/Q7/K7 w - - 0 1', false],
    ['6nk/8/8/8/8/8/R7/K7 w - - 0 1', true],
    ['5nnk/8/8/8/8/8/8/K7 w - - 0 1', true],
    ['6bk/8/8/8/8/8/Q7/K7 w - - 0 1', false],
    ['6bk/8/8/8/8/8/P7/K7 w - - 0 1', true],
    ['6bk/8/8/8/8/8/8/K1B5 w - - 0 1', true],
    ['6bk/8/8/8/8/8/8/K2B4 w - - 0 1', false],
  ]) {
    game.chess.load(fen);
    assert.equal(f.lobby.canPossiblyMate(game, 'b'), canMate, fen);
  }
});
