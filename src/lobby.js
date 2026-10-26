'use strict';

const crypto = require('node:crypto');
const { Chess } = require('chess.js');

const MAX_NAME_LENGTH = 20;

/**
 * Validates and normalises a display name.
 * Returns { name } on success or { error } on failure.
 */
function normalizeName(raw) {
  if (typeof raw !== 'string') return { error: 'Name is required.' };
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) return { error: 'Name is required.' };
  if (name.length > MAX_NAME_LENGTH) {
    return { error: `Name must be at most ${MAX_NAME_LENGTH} characters.` };
  }
  if (!/^[\p{L}\p{N} _.\-']+$/u.test(name)) {
    return { error: 'Name may only contain letters, numbers, spaces and _ . - \'' };
  }
  return { name };
}

/**
 * In-memory state for online players, pending challenges and live games.
 * Transport-agnostic: the socket layer translates results into events.
 */
class Lobby {
  constructor({ randomColor = () => Math.random() < 0.5 } = {}) {
    this.players = new Map(); // id -> { id, name, gameId }
    this.challenges = new Map(); // challengerId -> targetId
    this.games = new Map(); // gameId -> game
    this.randomColor = randomColor;
  }

  join(id, rawName) {
    if (this.players.has(id)) return { error: 'Already checked in.' };
    const { name, error } = normalizeName(rawName);
    if (error) return { error };
    const lower = name.toLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === lower) {
        return { error: 'That name is already taken by someone online.' };
      }
    }
    const player = { id, name, gameId: null };
    this.players.set(id, player);
    return { player };
  }

  listPlayers() {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, status: p.gameId ? 'playing' : 'idle' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  challenge(fromId, toId) {
    const from = this.players.get(fromId);
    const to = this.players.get(toId);
    if (!from) return { error: 'Check in first.' };
    if (!to) return { error: 'That player is no longer online.' };
    if (fromId === toId) return { error: 'You cannot challenge yourself.' };
    if (from.gameId) return { error: 'You are already in a game.' };
    if (to.gameId) return { error: `${to.name} is already in a game.` };
    this.challenges.set(fromId, toId);
    return { from, to };
  }

  /** Cancels any outgoing challenge from a player. Returns the target id, if any. */
  cancelChallenge(fromId) {
    const toId = this.challenges.get(fromId);
    this.challenges.delete(fromId);
    return toId;
  }

  respond(targetId, challengerId, accept) {
    if (this.challenges.get(challengerId) !== targetId) {
      return { error: 'That challenge is no longer available.' };
    }
    this.challenges.delete(challengerId);
    const challenger = this.players.get(challengerId);
    const target = this.players.get(targetId);
    if (!challenger || !target) return { error: 'That player is no longer online.' };
    if (!accept) return { declined: true, challenger, target };
    if (challenger.gameId || target.gameId) return { error: 'One of the players is already in a game.' };

    const challengerWhite = this.randomColor();
    const white = challengerWhite ? challenger : target;
    const black = challengerWhite ? target : challenger;
    const game = {
      id: crypto.randomUUID(),
      white: { id: white.id, name: white.name },
      black: { id: black.id, name: black.name },
      chess: new Chess(),
      lastMove: null,
      result: null,
      reason: null,
    };
    this.games.set(game.id, game);
    white.gameId = game.id;
    black.gameId = game.id;
    // Starting a game clears any other outstanding challenges involving these players.
    for (const [from, to] of this.challenges) {
      if ([from, to].some((pid) => pid === white.id || pid === black.id)) {
        this.challenges.delete(from);
      }
    }
    return { game };
  }

  colorOf(game, playerId) {
    if (game.white.id === playerId) return 'w';
    if (game.black.id === playerId) return 'b';
    return null;
  }

  move(playerId, gameId, { from, to, promotion } = {}) {
    const game = this.games.get(gameId);
    if (!game) return { error: 'Game not found.' };
    if (game.result) return { error: 'The game is over.' };
    const color = this.colorOf(game, playerId);
    if (!color) return { error: 'You are not playing in this game.' };
    if (game.chess.turn() !== color) return { error: 'It is not your turn.' };
    let move;
    try {
      move = game.chess.move({ from, to, promotion: promotion || 'q' });
    } catch {
      return { error: 'Illegal move.' };
    }
    game.lastMove = { from: move.from, to: move.to, san: move.san };
    this._checkGameEnd(game);
    return { game, move };
  }

  _checkGameEnd(game) {
    const c = game.chess;
    if (!c.isGameOver()) return;
    if (c.isCheckmate()) {
      this._finish(game, c.turn() === 'w' ? '0-1' : '1-0', 'checkmate');
    } else if (c.isStalemate()) {
      this._finish(game, '1/2-1/2', 'stalemate');
    } else if (c.isInsufficientMaterial()) {
      this._finish(game, '1/2-1/2', 'insufficient material');
    } else if (c.isThreefoldRepetition()) {
      this._finish(game, '1/2-1/2', 'threefold repetition');
    } else {
      this._finish(game, '1/2-1/2', 'fifty-move rule');
    }
  }

  _finish(game, result, reason) {
    game.result = result;
    game.reason = reason;
    for (const side of [game.white, game.black]) {
      const p = this.players.get(side.id);
      if (p && p.gameId === game.id) p.gameId = null;
    }
  }

  resign(playerId, gameId) {
    const game = this.games.get(gameId);
    if (!game || game.result) return { error: 'No active game to resign.' };
    const color = this.colorOf(game, playerId);
    if (!color) return { error: 'You are not playing in this game.' };
    this._finish(game, color === 'w' ? '0-1' : '1-0', 'resignation');
    return { game };
  }

  /** Removes a game once both players have seen the result. */
  removeGame(gameId) {
    this.games.delete(gameId);
  }

  /**
   * Removes a player. Returns the ids of players whose pending challenges were
   * affected and the game that was abandoned (if any).
   */
  leave(playerId) {
    const player = this.players.get(playerId);
    if (!player) return {};
    const cancelledTargets = [];
    const cancelledChallengers = [];
    for (const [from, to] of this.challenges) {
      if (from === playerId) {
        cancelledTargets.push(to);
        this.challenges.delete(from);
      } else if (to === playerId) {
        cancelledChallengers.push(from);
        this.challenges.delete(from);
      }
    }
    let game = null;
    if (player.gameId) {
      game = this.games.get(player.gameId);
      if (game && !game.result) {
        const color = this.colorOf(game, playerId);
        this._finish(game, color === 'w' ? '0-1' : '1-0', 'opponent left');
      }
    }
    this.players.delete(playerId);
    return { player, game, cancelledTargets, cancelledChallengers };
  }

  static gameState(game) {
    return {
      gameId: game.id,
      white: game.white,
      black: game.black,
      fen: game.chess.fen(),
      pgn: game.chess.pgn(),
      moves: game.chess.history(),
      turn: game.chess.turn(),
      inCheck: game.chess.inCheck(),
      lastMove: game.lastMove,
      result: game.result,
      reason: game.reason,
    };
  }
}

module.exports = { Lobby, normalizeName, MAX_NAME_LENGTH };
