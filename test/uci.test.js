'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('UCI info parsing and score formatting', async () => {
  const { parseInfoLine, formatScore, scoreToPercent, uciToMove } = await import('../public/uci.mjs');

  const line = 'info depth 12 seldepth 18 multipv 2 score cp 35 nodes 1000 nps 5000 pv e2e4 e7e5 g1f3';
  assert.deepEqual(parseInfoLine(line, 'w'), {
    depth: 12,
    multipv: 2,
    score: { type: 'cp', value: 35 },
    pv: ['e2e4', 'e7e5', 'g1f3'],
  });
  // Scores are reported from the side to move; convert to White's perspective.
  assert.deepEqual(parseInfoLine(line, 'b').score, { type: 'cp', value: -35 });
  assert.equal(parseInfoLine('info depth 5 score cp 10 lowerbound pv e2e4', 'w').bound, 'lowerbound');
  assert.deepEqual(parseInfoLine('info depth 20 score mate 3 pv d1h5', 'w').score, { type: 'mate', value: 3 });
  assert.equal(parseInfoLine('info string NNUE evaluation enabled'), null);
  assert.equal(parseInfoLine('info depth 0 score mate 0'), null);
  assert.equal(parseInfoLine('bestmove e2e4'), null);

  assert.equal(formatScore({ type: 'cp', value: 35 }), '+0.35');
  assert.equal(formatScore({ type: 'cp', value: -120 }), '-1.20');
  assert.equal(formatScore({ type: 'cp', value: 0 }), '0.00');
  assert.equal(formatScore({ type: 'mate', value: -2 }), '#-2');

  assert.equal(scoreToPercent(null), 50);
  assert.equal(scoreToPercent({ type: 'cp', value: 0 }), 50);
  assert.ok(scoreToPercent({ type: 'cp', value: 300 }) > 70);
  assert.equal(scoreToPercent({ type: 'mate', value: 1 }), 100);
  assert.equal(scoreToPercent({ type: 'mate', value: -1 }), 0);

  assert.deepEqual(uciToMove('e7e8q'), { from: 'e7', to: 'e8', promotion: 'q' });
});
