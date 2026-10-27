'use strict';

const crypto = require('node:crypto');
const { Chess } = require('chess.js');
const { CATALOG, assign, evaluate } = require('./quests');
const RULES = require('./rules');
const { normalizeName, MAX_NAME_LENGTH } = require('./names');

const TIME_MS = 600_000;
class Lobby {
  constructor(store, { now = Date.now, randomColor = () => Math.random() < 0.5,
    questCount = Number(process.env.QUEST_COUNT || 1), questLevel = process.env.QUEST_LEVEL || 'all',
    guessLimit = Number(process.env.GUESS_LIMIT || 2), ratingBand = 100, bandStep = 100, bandIntervalMs = 15_000 } = {}) {
    this.store = store;
    this.now = now;
    this.randomColor = randomColor;
    this.questCount = questCount;
    this.questLevel = questLevel;
    assign(questCount, questLevel);
    this.guessLimit = guessLimit;
    if (!Number.isInteger(guessLimit) || guessLimit < 1 || guessLimit > 10) throw new Error('GUESS_LIMIT must be an integer from 1 to 10.');
    this.ratingBand = ratingBand;
    this.bandStep = bandStep;
    this.bandIntervalMs = bandIntervalMs;
    this.connections = new Map();
    this.queue = new Map();
    this.challenges = new Map();
  }

  activeId(id) { return this.store.db.prepare('SELECT game_id FROM active_players WHERE user_id=?').get(id)?.game_id; }
  game(id) {
    const row = this.store.db.prepare('SELECT data FROM games WHERE id=?').get(id);
    if (!row) return null;
    const game = JSON.parse(row.data);
    game.chess = new Chess();
    for (const move of game.moves) game.chess.move(move.uci);
    return game;
  }
  colorOf(game, id) { return game.white.id === id ? 'w' : game.black.id === id ? 'b' : null; }
  side(game, color) { return color === 'w' ? game.white : game.black; }

  connect(userId, socketId) { this.connections.set(socketId, { userId, lastSeenAt: this.now() }); }
  heartbeat(socketId) {
    const connection = this.connections.get(socketId);
    if (connection) connection.lastSeenAt = this.now();
  }
  disconnect(socketId) {
    const connection = this.connections.get(socketId);
    this.connections.delete(socketId);
    if (connection && !this.online(connection.userId)) {
      this.queue.delete(connection.userId);
      for (const [from, to] of this.challenges) {
        if (from === connection.userId || to === connection.userId) this.challenges.delete(from);
      }
    }
  }
  online(id) {
    return [...this.connections.values()].some((c) => c.userId === id && this.now() - c.lastSeenAt < 60_000);
  }
  listPlayers() {
    const ids = new Set([...this.connections.values()].filter((c) => this.online(c.userId)).map((c) => c.userId));
    return [...ids].map((id) => this.store.user(id)).filter((u) => u.visible).map((u) => ({
      id: u.id, name: u.name, rating: u.rating, status: this.activeId(u.id) ? 'in_game' : 'online',
    })).sort((a, b) => a.name.localeCompare(b.name));
  }
  presence(id) { return !this.online(id) ? 'offline' : this.activeId(id) ? 'in_game' : 'online'; }

  challenge(fromId, rawName) {
    const { name, error } = normalizeName(rawName);
    if (error) return { error };
    const target = this.store.byName(name);
    if (!target || !this.online(target.id)) return { error: 'That player is unavailable.' };
    if (target.id === fromId) return { error: 'You cannot challenge yourself.' };
    if (this.activeId(fromId) || this.activeId(target.id)) return { error: 'One player is already in a game.' };
    this.challenges.set(fromId, target.id);
    const from = this.store.user(fromId);
    return { from: { id: from.id, name: from.name }, to: { id: target.id, name: target.name } };
  }
  respond(targetId, fromId, accept) {
    if (this.challenges.get(fromId) !== targetId) return { error: 'That challenge is no longer available.' };
    this.challenges.delete(fromId);
    if (!accept) return { declined: true, fromId, targetId };
    return this.start(fromId, targetId);
  }
  start(a, b) {
    if (a === b || !this.online(a) || !this.online(b)) return { error: 'Both players must be online.' };
    if (this.activeId(a) || this.activeId(b)) return { error: 'One player is already in a game.' };
    const [whiteId, blackId] = this.randomColor() ? [a, b] : [b, a];
    const white = this.store.user(whiteId);
    const black = this.store.user(blackId);
    const now = this.now();
    const game = {
      id: crypto.randomUUID(), white: { id: white.id, name: white.name }, black: { id: black.id, name: black.name },
      ratingBefore: { w: white.rating, b: black.rating }, chess: new Chess(), moves: [], fen: new Chess().fen(),
      timeControl: '10+0', clocks: { w: TIME_MS, b: TIME_MS }, lastClockAt: now,
      createdAt: now, version: 0, result: null, reason: null, drawOffer: null,
      rules: { ...RULES, guessLimit: this.guessLimit },
      assignments: { w: assign(this.questCount, this.questLevel), b: assign(this.questCount, this.questLevel) },
      guesses: { w: [], b: [] }, recap: null,
    };
    this.store.transaction(() => {
      this.store.saveGame(game);
      for (const id of [a, b]) this.store.db.prepare('INSERT INTO active_players VALUES (?,?)').run(id, game.id);
    });
    for (const id of [a, b]) this.queue.delete(id);
    for (const [from, to] of this.challenges) {
      if ([a, b].includes(from) || [a, b].includes(to)) this.challenges.delete(from);
    }
    return { game };
  }
  enqueue(id) {
    if (this.activeId(id)) return { error: 'You are already in a game.' };
    if (!this.queue.has(id)) this.queue.set(id, { joinedAt: this.now(), rating: this.store.user(id).rating });
    return { ok: true };
  }
  pair() {
    const games = [];
    for (const [a, first] of this.queue) {
      if (!this.online(a) || this.activeId(a)) { this.queue.delete(a); continue; }
      for (const [b, second] of this.queue) {
        if (a === b || !this.online(b) || this.activeId(b)) continue;
        const wait = this.now() - Math.min(first.joinedAt, second.joinedAt);
        const band = this.ratingBand + Math.floor(wait / this.bandIntervalMs) * this.bandStep;
        if (Math.abs(first.rating - second.rating) > band) continue;
        const result = this.start(a, b);
        if (result.game) games.push(result.game);
        break;
      }
    }
    return games;
  }

  // A timeout is a draw when the non-flagging side cannot possibly mate.
  canPossiblyMate(game, winner) {
    const pieces = game.chess.board().flat().filter(Boolean);
    const own = pieces.filter((p) => p.color === winner && p.type !== 'k');
    if (!own.length) return false;
    if (own.some((p) => ['p', 'r', 'q'].includes(p.type))) return true;
    if (own.some((p) => p.type === 'n')) {
      if (own.length >= 2) return true;
      return pieces.some((p) => p.color !== winner && p.type !== 'k' && p.type !== 'q');
    }
    const squareColor = (p) => (p.square.charCodeAt(0) + Number(p.square[1])) % 2;
    const colors = new Set(own.map(squareColor));
    if (colors.size === 2) return true;
    return pieces.some((p) => p.color !== winner && p.type !== 'k'
      && (p.type === 'p' || p.type === 'n' || (p.type === 'b' && !colors.has(squareColor(p)))));
  }
  touch(game) {
    if (game.result) return;
    const now = this.now();
    const turn = game.chess.turn();
    game.clocks[turn] = Math.max(0, game.clocks[turn] - Math.max(0, now - game.lastClockAt));
    game.lastClockAt = now;
    if (game.clocks[turn] === 0) {
      const winner = turn === 'w' ? 'b' : 'w';
      this.finish(game, this.canPossiblyMate(game, winner) ? winner === 'w' ? '1-0' : '0-1' : '1/2-1/2', 'timeout');
    }
  }
  finish(game, result, reason) {
    if (game.result) return;
    game.result = result;
    game.reason = reason;
    game.finishedAt = this.now();
    game.version++;
  }
  checkEnd(game) {
    const c = game.chess;
    if (c.isCheckmate()) this.finish(game, c.turn() === 'w' ? '0-1' : '1-0', 'checkmate');
    else if (c.isStalemate()) this.finish(game, '1/2-1/2', 'stalemate');
    else if (c.isInsufficientMaterial()) this.finish(game, '1/2-1/2', 'insufficient material');
    else if (Number(c.fen().split(' ')[4]) >= 150) this.finish(game, '1/2-1/2', 'seventy-five-move rule');
    else {
      const positions = [new Chess().fen(), ...game.moves.map((m) => m.fenAfter)];
      const key = c.fen().split(' ').slice(0, 4).join(' ');
      if (positions.filter((fen) => fen.split(' ').slice(0, 4).join(' ') === key).length >= 5) {
        this.finish(game, '1/2-1/2', 'fivefold repetition');
      }
    }
  }

  act(id, action, data = {}) {
    const game = this.game(data.gameId);
    if (!game) return { error: 'Game not found.' };
    const color = this.colorOf(game, id);
    if (!color) return { error: 'You are not playing in this game.' };
    if (game.result) return { error: 'The game is over.' };
    return this.store.transaction(() => {
      this.touch(game);
      let error = game.result ? 'The game is over.' : null;
      if (!error) error = this.apply(game, color, action, data);
      this.persist(game);
      return { game, ...(error ? { error } : { ok: true }) };
    });
  }

  apply(game, color, action, data) {
    const opponent = color === 'w' ? 'b' : 'w';
    if (action === 'move') {
      if (data.version !== game.version) return 'Stale game version. Board refreshed; try again.';
      if (game.chess.turn() !== color) return 'It is not your turn.';
      if (!/^[a-h][1-8]$/.test(data.from) || !/^[a-h][1-8]$/.test(data.to)
        || (data.promotion !== undefined && !['q', 'r', 'b', 'n'].includes(data.promotion))) return 'Illegal move.';
      let move;
      try { move = game.chess.move({ from: data.from, to: data.to, promotion: data.promotion || 'q' }); }
      catch { return 'Illegal move.'; }
      game.moves.push({
        ply: game.moves.length + 1, san: move.san, uci: move.from + move.to + (move.promotion || ''),
        fenAfter: game.chess.fen(), acceptedAt: this.now(),
      });
      game.fen = game.chess.fen();
      game.version++;
      game.drawOffer = null;
      evaluate(game.assignments[color], move, game.chess, game.moves.length, this.now());
      this.checkEnd(game);
      return null;
    }
    if (action === 'guess') {
      const guesses = game.guesses[color];
      if (guesses.length >= game.rules.guessLimit) return 'No guess attempts remaining.';
      if (!CATALOG.some((q) => q.enabled && q.questId === data.questId)) return 'Invalid objective.';
      if (guesses.some((g) => g.questId === data.questId)) return 'You already guessed that objective.';
      if (guesses.length && this.now() - guesses.at(-1).submittedAt < 1000) return 'Wait one second between guesses.';
      const assignment = game.assignments[opponent].find((q) => q.questId === data.questId);
      // Completed and unassigned objectives have the same failed-attempt response.
      const correct = Boolean(assignment && assignment.completedAtPly === null);
      guesses.push({ questId: data.questId, correct, submittedAt: this.now() });
      game.version++;
      return correct ? null : 'Guess incorrect or no longer eligible. Attempt used.';
    }
    if (action === 'resign') { this.finish(game, color === 'w' ? '0-1' : '1-0', 'resignation'); return null; }
    if (action === 'offerDraw') {
      if (game.drawOffer) return 'A draw offer is already pending.';
      game.drawOffer = color;
      game.version++;
      return null;
    }
    if (action === 'respondDraw') {
      if (game.drawOffer !== opponent) return 'No opponent draw offer is pending.';
      if (data.accept === true) this.finish(game, '1/2-1/2', 'agreement');
      game.drawOffer = null;
      game.version++;
      return null;
    }
    if (action === 'claimDraw') {
      if (game.chess.turn() !== color) return 'Only the player to move may claim a draw.';
      let candidate = game.chess;
      if (data.from !== undefined || data.to !== undefined) {
        if (data.version !== game.version) return 'Stale game version. Board refreshed; try again.';
        candidate = new Chess();
        for (const move of game.moves) candidate.move(move.uci);
        try { candidate.move({ from: data.from, to: data.to, promotion: data.promotion || 'q' }); }
        catch { return 'Illegal intended move for draw claim.'; }
      }
      if (candidate.isCheckmate()) return 'Checkmate takes precedence over a rule draw.';
      if (candidate.isThreefoldRepetition()) this.finish(game, '1/2-1/2', 'threefold repetition');
      else if (candidate.isDrawByFiftyMoves()) this.finish(game, '1/2-1/2', 'fifty-move rule');
      else return 'No draw can currently be claimed.';
      if (candidate !== game.chess) game.drawClaim = {
        uci: data.from + data.to + (data.promotion || ''), fen: candidate.fen(), claimedAt: this.now(),
      };
      return null;
    }
    return 'Unknown game action.';
  }

  persist(game) {
    this.store.saveGame(game);
    const db = this.store.db;
    for (const move of game.moves) db.prepare('INSERT OR IGNORE INTO moves VALUES (?,?,?)').run(game.id, move.ply, JSON.stringify(move));
    for (const color of ['w', 'b']) {
      const id = this.side(game, color).id;
      for (const q of game.assignments[color].filter((q) => q.completedAtPly !== null)) {
        db.prepare('INSERT OR IGNORE INTO quest_completions VALUES (?,?,?,?)').run(game.id, id, q.questId, JSON.stringify(q));
      }
      for (const guess of game.guesses[color]) {
        db.prepare('INSERT OR IGNORE INTO guesses VALUES (?,?,?,?)').run(game.id, id, guess.questId, JSON.stringify(guess));
      }
    }
    if (game.result && !game.recap) this.finalize(game);
    this.store.saveGame(game);
  }

  finalize(game) {
    if (this.store.db.prepare('SELECT 1 FROM rating_changes WHERE game_id=?').get(game.id)) throw new Error('Finalization record mismatch.');
    const flags = [];
    if (game.moves.length < game.rules.minRewardPlies) flags.push(`fewer than ${game.rules.minRewardPlies} plies`);
    if (game.reason === 'server abandonment') flags.push('server abandonment');
    const day = new Date(game.finishedAt).toISOString().slice(0, 10);
    const prior = this.store.loadGames().filter((g) => g.id !== game.id && g.recap?.xpEligible
      && new Date(g.finishedAt).toISOString().slice(0, 10) === day
      && [g.white.id, g.black.id].includes(game.white.id) && [g.white.id, g.black.id].includes(game.black.id));
    if (prior.length >= game.rules.dailyOpponentCap) flags.push('repeat-opponent daily cap');
    const xpEligible = flags.length === 0;
    const scoreW = game.result === '1-0' ? 1 : game.result === '0-1' ? 0 : 0.5;
    const users = { w: this.store.user(game.white.id), b: this.store.user(game.black.id) };
    const expectedW = 1 / (1 + 10 ** ((users.b.rating - users.w.rating) / 400));
    const change = game.reason === 'server abandonment' ? 0 : Math.round(game.rules.eloK * (scoreW - expectedW));
    game.recap = { xpEligible, flags, players: {} };
    for (const color of ['w', 'b']) {
      const user = users[color];
      const score = color === 'w' ? scoreW : 1 - scoreW;
      const multiplier = game.rules.multipliers[score === 1 ? 'win' : score === 0 ? 'loss' : 'draw'];
      const events = [
        ...game.assignments[color].filter((q) => q.completedAtPly !== null).map((q) => ({ source: 'quest', questId: q.questId, baseAmount: q.baseXp })),
        ...game.guesses[color].filter((g) => g.correct).map((g) => ({ source: 'guess', questId: g.questId, baseAmount: game.rules.guessXp })),
      ];
      const total = xpEligible ? Math.floor(events.reduce((sum, e) => sum + e.baseAmount, 0) * multiplier) : 0;
      const after = user.rating + (color === 'w' ? change : -change);
      const ledger = { events, multiplier, total, flags };
      this.store.db.prepare('INSERT INTO xp_ledger VALUES (?,?,?)').run(game.id, user.id, JSON.stringify(ledger));
      this.store.db.prepare('INSERT INTO rating_changes VALUES (?,?,?,?)').run(game.id, user.id, user.rating, after);
      this.store.db.prepare('UPDATE users SET rating=?,xp=xp+?,rated_games=rated_games+? WHERE id=?')
        .run(after, total, Number(game.reason !== 'server abandonment'), user.id);
      game.recap.players[color] = {
        id: user.id, name: user.name, ratingBefore: user.rating, ratingAfter: after,
        ratingDelta: after - user.rating, ...ledger, totalXp: user.xp + total,
        quests: game.assignments[color], guesses: game.guesses[color],
      };
    }
    this.store.db.prepare('DELETE FROM active_players WHERE game_id=?').run(game.id);
    if (flags.length) console.info('Reward eligibility:', game.id, flags.join(', '));
  }

  tick() {
    for (const [socketId, c] of this.connections) if (this.now() - c.lastSeenAt >= 60_000) this.disconnect(socketId);
    const finished = [];
    for (const { game_id: id } of this.store.db.prepare('SELECT DISTINCT game_id FROM active_players').all()) {
      const game = this.game(id);
      this.touch(game);
      if (game.result) {
        this.store.transaction(() => this.persist(game));
        finished.push(game);
      }
    }
    return finished;
  }

  snapshot(game, id) {
    const color = this.colorOf(game, id);
    if (!color) return null;
    const opponent = color === 'w' ? 'b' : 'w';
    const clocks = { ...game.clocks };
    if (!game.result) clocks[game.chess.turn()] = Math.max(0, clocks[game.chess.turn()] - Math.max(0, this.now() - game.lastClockAt));
    const guessed = new Set(game.guesses[color].filter((g) => g.correct).map((g) => g.questId));
    return {
      gameId: game.id, white: game.white, black: game.black, fen: game.chess.fen(), turn: game.chess.turn(),
      moves: game.moves.map((m) => m.san), moveRecords: game.moves, version: game.version, timeControl: '10+0',
      clocks, serverNow: this.now(), result: game.result, reason: game.reason, drawOffer: game.drawOffer,
      ownQuests: game.assignments[color], guesses: game.guesses[color],
      guessLimit: game.rules.guessLimit, guessXp: game.rules.guessXp, eloK: game.rules.eloK,
      guessesRemaining: game.rules.guessLimit - game.guesses[color].length,
      revealedQuests: game.assignments[opponent].filter((q) => guessed.has(q.questId)),
      recap: game.result ? game.recap : null,
      drawClaim: game.drawClaim || null,
    };
  }
  history(id) {
    return this.store.loadGames().filter((g) => g.result && this.colorOf(g, id))
      .sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 30).map((g) => ({
        gameId: g.id, white: g.white.name, black: g.black.name, result: g.result, reason: g.reason, finishedAt: g.finishedAt,
      }));
  }
}

module.exports = { Lobby, normalizeName, MAX_NAME_LENGTH, TIME_MS };
