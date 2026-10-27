'use strict';

const { Chess } = require('chess.js');
const crypto = require('node:crypto');
const RULES = require('./rules');

const seeds = [
  ['E01', 'Easy', 'Knight captures bishop', 'capture:n:b'],
  ['E02', 'Easy', 'Bishop captures knight', 'capture:b:n'],
  ['E03', 'Easy', 'Rook captures bishop', 'capture:r:b'],
  ['E04', 'Easy', 'Castle queenside', 'queenside'],
  ['E05', 'Easy', 'Force a queen trade'],
  ['E06', 'Easy', 'Create a passed pawn', 'passed'],
  ['M01', 'Medium', 'Win material with knight fork'],
  ['M02', 'Medium', 'Win material with bishop fork'],
  ['M03', 'Medium', 'Win material with pawn fork'],
  ['M04', 'Medium', 'Execute rook skewer'],
  ['M05', 'Medium', 'Execute bishop skewer'],
  ['M06', 'Medium', 'Pin a knight to queen'],
  ['M07', 'Medium', 'Pin a piece to king'],
  ['M08', 'Medium', 'Capture en passant', 'enpassant'],
  ['H01', 'Hard', 'Discover an attack on queen'],
  ['H02', 'Hard', 'Deliver a double check', 'doublecheck'],
  ['H03', 'Hard', 'Win a piece via discovered attack'],
  ['H04', 'Hard', 'Promote a pawn', 'promotion'],
  ['H05', 'Hard', 'Deliver checkmate with rook', 'rookmate'],
  ['H06', 'Hard', 'Win a piece by removing its defender'],
];
const CATALOG = seeds.map(([questId, level, title, validatorKey]) => ({
  questId, level, title, baseXp: RULES.xpByLevel[level], validatorKey: validatorKey || null,
  enabled: Boolean(validatorKey), eligibility: 'standard-start',
}));

function passed(chess, pawn) {
  const file = pawn.square.charCodeAt(0);
  const rank = Number(pawn.square[1]);
  return !chess.board().flat().some((other) => other?.type === 'p' && other.color !== pawn.color
    && Math.abs(other.square.charCodeAt(0) - file) <= 1
    && (pawn.color === 'w' ? Number(other.square[1]) > rank : Number(other.square[1]) < rank));
}

function validates(definition, move, chess) {
  const key = definition.validatorKey;
  if (!definition.enabled) return false;
  if (key.startsWith('capture:')) {
    const [, piece, captured] = key.split(':');
    return move.piece === piece && move.captured === captured;
  }
  if (key === 'queenside') return move.flags.includes('q');
  if (key === 'enpassant') return move.flags.includes('e');
  if (key === 'promotion') return Boolean(move.promotion);
  if (key === 'rookmate') return move.piece === 'r' && chess.isCheckmate();
  if (key === 'doublecheck') {
    const king = chess.board().flat().find((p) => p?.type === 'k' && p.color !== move.color);
    return chess.inCheck() && chess.attackers(king.square, move.color).length >= 2;
  }
  if (key === 'passed') {
    const before = new Chess(move.before);
    return chess.board().flat().some((pawn) => {
      if (pawn?.type !== 'p' || pawn.color !== move.color || !passed(chess, pawn)) return false;
      const previousSquare = move.piece === 'p' && pawn.square === move.to ? move.from : pawn.square;
      const previous = before.get(previousSquare);
      return previous?.type === 'p' && previous.color === move.color && !passed(before, { ...previous, square: previousSquare });
    });
  }
  throw new Error(`Unknown quest validator: ${key}`);
}

function assign(count = 1, level = 'all') {
  if (![1, 2].includes(count)) throw new Error('QUEST_COUNT must be 1 or 2.');
  if (!['all', 'Easy', 'Medium', 'Hard'].includes(level)) throw new Error('Invalid QUEST_LEVEL.');
  const pool = CATALOG.filter((q) => q.enabled && (level === 'all' || q.level === level));
  if (pool.length < count) throw new Error('Not enough eligible quests for this configuration.');
  const selected = [];
  while (selected.length < count) {
    const index = crypto.randomInt(pool.length);
    selected.push({ ...pool.splice(index, 1)[0], completedAtPly: null, completedAt: null, evidence: null });
  }
  return selected;
}

function evaluate(assignments, move, chess, ply, now) {
  for (const assignment of assignments) {
    if (assignment.completedAtPly !== null || !validates(assignment, move, chess)) continue;
    assignment.completedAtPly = ply;
    assignment.completedAt = now;
    assignment.evidence = { ply, san: move.san, uci: move.from + move.to + (move.promotion || ''), fen: chess.fen() };
  }
}

module.exports = { CATALOG, assign, evaluate, validates };
