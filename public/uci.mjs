// Helpers for parsing UCI output from Stockfish. Shared by the browser and tests.

/**
 * Parses a UCI "info" line containing a principal variation.
 * Returns null for lines without a score + pv (e.g. "info string ...", "info currmove ...").
 * The score is converted to White's point of view using the side to move.
 */
export function parseInfoLine(line, sideToMove = 'w') {
  if (typeof line !== 'string' || !line.startsWith('info ')) return null;
  const tokens = line.trim().split(/\s+/);
  const info = { depth: 0, multipv: 1, score: null, pv: [] };
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'depth') info.depth = Number(tokens[++i]);
    else if (t === 'multipv') info.multipv = Number(tokens[++i]);
    else if (t === 'score') {
      const type = tokens[++i];
      const value = Number(tokens[++i]);
      if (type === 'cp' || type === 'mate') info.score = { type, value };
      if (tokens[i + 1] === 'lowerbound' || tokens[i + 1] === 'upperbound') info.bound = tokens[++i];
    } else if (t === 'pv') {
      info.pv = tokens.slice(i + 1);
      break;
    }
  }
  if (!info.score || info.pv.length === 0) return null;
  if (sideToMove === 'b') info.score = { type: info.score.type, value: -info.score.value };
  return info;
}

/** Formats a White-relative score as "+0.35", "-1.20", "#3" or "#-2". */
export function formatScore(score) {
  if (!score) return '';
  if (score.type === 'mate') return `#${score.value}`;
  const pawns = score.value / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

/** Returns White's share of the evaluation bar in percent (0–100). */
export function scoreToPercent(score) {
  if (!score) return 50;
  if (score.type === 'mate') {
    if (score.value === 0) return 50;
    return score.value > 0 ? 100 : 0;
  }
  // Logistic curve similar to common win-probability models.
  const p = 1 / (1 + Math.exp(-0.004 * score.value));
  return Math.round(p * 1000) / 10;
}

/** Converts a UCI move such as "e7e8q" into { from, to, promotion }. */
export function uciToMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] };
}
