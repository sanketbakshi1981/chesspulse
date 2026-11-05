'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Chess } = require('chess.js');
const { CATALOG, validates, evaluate } = require('../src/quests');

function check(id, fen, san, color) {
  const chess = new Chess(fen);
  const move = chess.move(san);
  return validates(CATALOG.find((q) => q.questId === id), move, chess, color);
}

test('catalog contains 20 stable seeds; only precisely defined validators are enabled', () => {
  assert.equal(CATALOG.length, 20);
  assert.equal(new Set(CATALOG.map((q) => q.questId)).size, 20);
  assert.equal(CATALOG.filter((q) => q.enabled).length, 9);
  assert.ok(CATALOG.filter((q) => !q.enabled).every((q) => q.validatorKey === null));
});

const cases = [
  ['E01', '4k3/8/8/3b4/8/2N5/8/4K3 w - - 0 1', 'Nxd5', 'Nb5'],
  ['E02', '4k3/8/8/4n3/8/2B5/8/4K3 w - - 0 1', 'Bxe5', 'Bb4'],
  ['E03', '4k3/8/8/8/8/8/b7/R3K3 w Q - 0 1', 'Rxa2', 'Rb1'],
  ['E04', 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'O-O-O', 'O-O'],
  ['E06', '4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1', 'exd5', 'Kd2'],
  ['M08', '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'exd6', 'e6'],
  ['H02', '4k3/8/8/8/8/8/4B3/K3R3 w - - 0 1', 'Bb5+', 'Bf1+'],
  ['H04', '7k/P7/8/8/8/8/8/4K3 w - - 0 1', 'a8=N', 'Kd2'],
  ['H05', '7k/5K2/8/8/8/8/8/6R1 w - - 0 1', 'Rh1#', 'Rg7'],
];
for (const [id, fen, positive, negative] of cases) {
  test(`${id} accepts precise legal completion and rejects near miss`, () => {
    assert.equal(check(id, fen, positive), true);
    assert.equal(check(id, fen, negative), false);
    if (id !== 'E06') {
      const opponent = new Chess(fen).turn() === 'w' ? 'b' : 'w';
      assert.equal(check(id, fen, positive, opponent), false);
    }
  });
}
test('passed pawn quest accepts an existing passed pawn and supports black', () => {
  assert.equal(check('E06', '4k3/8/8/8/4P3/8/8/4K3 w - - 0 1', 'e5'), true);
  assert.equal(check('E06', '4k3/8/8/4p3/3P4/8/8/4K3 b - - 0 1', 'exd4'), true);
});
test('screenshot a2 pawn passes for White even on Black checkmating move', () => {
  assert.equal(check('E06', 'r5k1/5rpp/b1p5/2b1p3/2N1Pn2/1P1q1P2/P6P/R1B1K3 b - - 0 1', 'Ng2#', 'w'), true);
});
test('passed pawn checks own and adjacent files ahead, in either direction', () => {
  for (const square of ['a7', 'b7']) {
    const chess = new Chess('4k3/8/8/8/8/8/P7/4K3 w - - 0 1');
    chess.put({ type: 'p', color: 'b' }, square);
    const move = chess.move('Kd2');
    assert.equal(validates(CATALOG.find((q) => q.questId === 'E06'), move, chess), false);
  }
  for (const square of ['g2', 'h2']) {
    const chess = new Chess('4k3/7p/8/8/8/8/8/4K3 b - - 0 1');
    chess.put({ type: 'p', color: 'w' }, square);
    const move = chess.move('Kd7');
    assert.equal(validates(CATALOG.find((q) => q.questId === 'E06'), move, chess), false);
  }
  assert.equal(check('E06', '4k3/2p5/8/Pp6/8/8/8/4K3 w - - 0 1', 'Kd2'), true);
  assert.equal(check('E06', '4k3/8/8/8/6Pp/8/5P2/4K3 b - - 0 1', 'Kd7'), true);
});
test('opponent moves can leave a passed pawn for either quest owner', () => {
  assert.equal(check('E06', '4k3/8/8/8/1p6/2N5/P7/4K3 b - - 0 1', 'bxc3', 'w'), true);
  assert.equal(check('E06', '4k3/7p/5n2/6P1/8/8/8/4K3 w - - 0 1', 'gxf6', 'b'), true);
  assert.equal(check('E06', '4k3/8/8/8/1p6/2N5/P7/4K3 b - - 0 1', 'b3', 'w'), false);
  assert.equal(check('E06', '4k3/8/8/8/p7/8/8/4K3 w - - 0 1', 'Kd2', 'w'), false);
});
test('rook mate includes already-promoted rooks but not the promotion move itself', () => {
  assert.equal(check('H05', '7k/5K2/8/8/8/8/8/6R1 w - - 0 1', 'Rh1#'), true);
  assert.equal(check('H05', '7k/5KP1/8/8/8/8/8/8 w - - 0 1', 'g8=R+'), false);
});
test('completions are deterministic and immutable when evaluated repeatedly', () => {
  const run = () => {
    const chess = new Chess('4k3/8/8/3b4/8/2N5/8/4K3 w - - 0 1');
    const move = chess.move('Nxd5');
    const quests = [{ ...CATALOG[0], completedAtPly: null, completedAt: null, evidence: null }];
    evaluate(quests, move, chess, 1, 1000);
    evaluate(quests, move, chess, 2, 2000);
    return quests;
  };
  assert.deepEqual(run(), run());
  assert.equal(run()[0].completedAtPly, 1);
  assert.equal(run()[0].completedAt, 1000);
});
