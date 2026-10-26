import { Chess } from '/vendor/chess/chess.js';
import { Engine } from './engine.mjs';
import { formatScore, scoreToPercent, uciToMove } from './uci.mjs';

const GLYPHS = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const FILES = 'abcdefgh';
const RESULT_TEXT = { '1-0': 'White wins', '0-1': 'Black wins', '1/2-1/2': 'Draw' };

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const socket = io({ autoConnect: false });

const state = {
  me: null,
  players: [],
  chess: new Chess(),
  mode: 'analysis', // 'analysis' (free board) or 'game' (live game vs. another player)
  game: null, // last game state received from the server
  myColor: null,
  orientation: 'w',
  selected: null,
  targets: [],
  pendingPromotion: null,
  outgoing: null, // id of the player I have challenged
  incoming: new Map(), // challenger id -> name
  engineLines: [],
  engineFen: null,
};

const engine = new Engine({
  onUpdate(fen, lines) {
    state.engineFen = fen;
    state.engineLines = lines;
    renderEngine();
  },
  onStatus(text) {
    $('engine-status').textContent = text;
  },
});

// ---------- Check-in ----------

const savedName = localStorage.getItem('chesspulse:name');
if (savedName) $('name-input').value = savedName;

$('checkin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('name-input').value;
  $('checkin-error').textContent = '';
  if (!socket.connected) socket.connect();
  join(name, (err) => {
    if (err) $('checkin-error').textContent = err;
  });
});

function join(name, done) {
  socket.emit('join', { name }, (res) => {
    if (res?.error) return done(res.error);
    state.me = { id: res.id, name: res.name };
    localStorage.setItem('chesspulse:name', res.name);
    $('checkin').hidden = true;
    $('app').hidden = false;
    $('me').textContent = `Checked in as ${res.name}`;
    done(null);
    render();
  });
}

// If the connection drops and comes back, check in again automatically.
socket.on('connect', () => {
  if (state.me && state.me.id !== socket.id) {
    const name = state.me.name;
    if (state.mode === 'game') endLiveGame('Connection lost — the game was abandoned.');
    state.outgoing = null;
    state.incoming.clear();
    join(name, (err) => {
      if (err) setLobbyStatus(`Reconnected, but could not check in: ${err}`);
    });
  }
});

// ---------- Lobby ----------

socket.on('players', (players) => {
  state.players = players;
  if (state.outgoing && !players.some((p) => p.id === state.outgoing)) state.outgoing = null;
  renderLobby();
});

socket.on('challenge:incoming', ({ from }) => {
  state.incoming.set(from.id, from.name);
  renderLobby();
});

socket.on('challenge:cancelled', ({ from }) => {
  state.incoming.delete(from);
  renderLobby();
});

socket.on('challenge:declined', ({ by }) => {
  if (state.outgoing === by.id) state.outgoing = null;
  setLobbyStatus(`${by.name} declined your challenge.`);
  renderLobby();
});

function setLobbyStatus(text) {
  $('lobby-status').textContent = text;
}

function challenge(player) {
  socket.emit('challenge', { to: player.id }, (res) => {
    if (res?.error) return setLobbyStatus(res.error);
    state.outgoing = player.id;
    setLobbyStatus(`Waiting for ${player.name} to respond…`);
    renderLobby();
  });
}

function cancelChallenge() {
  socket.emit('challenge:cancel');
  state.outgoing = null;
  setLobbyStatus('');
  renderLobby();
}

function respond(fromId, accept) {
  state.incoming.delete(fromId);
  socket.emit('challenge:respond', { from: fromId, accept }, (res) => {
    if (res?.error) setLobbyStatus(res.error);
  });
  renderLobby();
}

function renderLobby() {
  const inGame = state.mode === 'game';
  $('online-count').textContent = state.players.length;
  const list = $('players');
  list.replaceChildren();
  for (const p of state.players) {
    const isMe = p.id === state.me?.id;
    const status = el('span', {
      className: `status ${p.status}`,
      textContent: isMe ? '(you)' : p.status === 'playing' ? 'playing' : 'available',
    });
    const li = el('li', {}, el('span', {}, el('span', { textContent: `${p.name} ` }), status));
    if (!isMe) {
      if (state.outgoing === p.id) {
        li.append(el('button', { className: 'secondary', textContent: 'Cancel', onclick: cancelChallenge }));
      } else {
        li.append(
          el('button', {
            textContent: 'Challenge',
            disabled: inGame || p.status === 'playing',
            onclick: () => challenge(p),
          }),
        );
      }
    }
    list.append(li);
  }

  const box = $('challenges');
  box.replaceChildren();
  for (const [id, name] of state.incoming) {
    box.append(
      el(
        'div',
        { className: 'challenge' },
        el('div', { textContent: `${name} challenges you to a game!` }),
        el(
          'div',
          { className: 'actions' },
          el('button', { textContent: 'Accept', disabled: inGame, onclick: () => respond(id, true) }),
          el('button', { className: 'secondary', textContent: 'Decline', onclick: () => respond(id, false) }),
        ),
      ),
    );
  }
}

// ---------- Live games ----------

socket.on('game:start', (game) => {
  state.mode = 'game';
  state.game = game;
  state.myColor = game.white.id === state.me.id ? 'w' : 'b';
  state.orientation = state.myColor;
  state.outgoing = null;
  state.incoming.clear();
  setLobbyStatus('');
  loadMoves(game.moves);
  setEngineEnabled(false);
  render();
});

socket.on('game:update', (game) => {
  if (state.mode !== 'game' || state.game?.gameId !== game.gameId) return;
  state.game = game;
  loadMoves(game.moves);
  if (game.result) {
    const reason = game.reason ? ` by ${game.reason}` : '';
    endLiveGame(`${RESULT_TEXT[game.result]}${reason}. You can now analyse the game.`);
  } else {
    render();
  }
});

function endLiveGame(message) {
  state.mode = 'analysis';
  state.myColor = null;
  $('game-status').textContent = message;
  render(false);
}

function loadMoves(moves) {
  const chess = new Chess();
  for (const san of moves) chess.move(san);
  state.chess = chess;
  state.selected = null;
  state.targets = [];
}

$('resign-btn').addEventListener('click', () => {
  if (state.mode !== 'game' || !confirm('Resign this game?')) return;
  socket.emit('resign', { gameId: state.game.gameId });
});

// ---------- Board ----------

function canMove() {
  if (state.mode === 'analysis') return true;
  return !state.game.result && state.chess.turn() === state.myColor;
}

function onSquareClick(square) {
  if (state.pendingPromotion) return;
  const piece = state.chess.get(square);
  const target = state.targets.filter((m) => m.to === square);
  if (state.selected && target.length) {
    if (target.some((m) => m.promotion)) {
      showPromotion(state.selected, square);
    } else {
      makeMove({ from: state.selected, to: square });
    }
    return;
  }
  if (piece && piece.color === state.chess.turn() && canMove() && state.selected !== square) {
    state.selected = square;
    state.targets = state.chess.moves({ square, verbose: true });
  } else {
    state.selected = null;
    state.targets = [];
  }
  renderBoard();
}

function showPromotion(from, to) {
  const color = state.chess.turn();
  const box = $('promotion');
  state.pendingPromotion = { from, to };
  box.replaceChildren(
    ...['q', 'r', 'b', 'n'].map((p) =>
      el('button', {
        className: `piece ${color}`,
        textContent: GLYPHS[p],
        title: { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[p],
        onclick: () => {
          box.hidden = true;
          state.pendingPromotion = null;
          makeMove({ from, to, promotion: p });
        },
      }),
    ),
  );
  box.hidden = false;
}

function makeMove(move) {
  try {
    state.chess.move(move);
  } catch {
    return;
  }
  state.selected = null;
  state.targets = [];
  if (state.mode === 'game') {
    socket.emit('move', { gameId: state.game.gameId, ...move }, (res) => {
      if (res?.error) {
        $('game-status').textContent = res.error;
        loadMoves(state.game.moves);
        render();
      }
    });
  }
  render();
}

function lastMove() {
  const history = state.chess.history({ verbose: true });
  return history[history.length - 1] || null;
}

function renderBoard() {
  const board = $('board');
  const grid = state.chess.board();
  const last = lastMove();
  const targetSquares = new Map(state.targets.map((m) => [m.to, m]));
  const checkedKing =
    state.chess.inCheck() &&
    grid.flat().find((p) => p && p.type === 'k' && p.color === state.chess.turn())?.square;
  const flipped = state.orientation === 'b';
  const squares = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const row = flipped ? 7 - r : r;
      const col = flipped ? 7 - f : f;
      const square = `${FILES[col]}${8 - row}`;
      const piece = grid[row][col];
      const classes = ['sq', (row + col) % 2 === 0 ? 'light' : 'dark'];
      if (last && (last.from === square || last.to === square)) classes.push('last');
      if (state.selected === square) classes.push('selected');
      if (targetSquares.has(square)) {
        classes.push('target');
        if (piece || targetSquares.get(square).flags.includes('e')) classes.push('capture');
      }
      if (checkedKing === square) classes.push('check');
      const sq = el('div', { className: classes.join(' '), onclick: () => onSquareClick(square) });
      sq.dataset.square = square;
      if (piece) sq.append(el('span', { className: `piece ${piece.color}`, textContent: GLYPHS[piece.type] }));
      if (r === 7) sq.append(el('span', { className: 'coord file', textContent: FILES[col] }));
      if (f === 0) sq.append(el('span', { className: 'coord rank', textContent: String(8 - row) }));
      squares.push(sq);
    }
  }
  board.replaceChildren(...squares);
}

function renderPlayers() {
  const turn = state.chess.turn();
  const label = (color) => {
    let name = color === 'w' ? 'White' : 'Black';
    if (state.game) name = `${state.game[color === 'w' ? 'white' : 'black'].name} (${name})`;
    const node = el('span', { textContent: name });
    if (turn === color && !state.chess.isGameOver()) node.append(el('span', { className: 'turn', textContent: ' ●' }));
    return node;
  };
  const bottom = state.orientation;
  const top = bottom === 'w' ? 'b' : 'w';
  $('top-player').replaceChildren(label(top));
  $('bottom-player').replaceChildren(label(bottom));
}

function renderStatus() {
  if (state.mode !== 'game') return;
  const c = state.chess;
  let text = c.turn() === state.myColor ? 'Your move.' : 'Waiting for your opponent…';
  if (c.inCheck()) text = `Check! ${text}`;
  $('game-status').textContent = text;
}

function renderMoves() {
  const history = state.chess.history();
  const list = $('moves');
  list.replaceChildren();
  for (let i = 0; i < history.length; i += 2) {
    list.append(
      el(
        'li',
        {},
        el('span', { textContent: history[i] }),
        el('span', { textContent: history[i + 1] || '' }),
      ),
    );
  }
  list.scrollTop = list.scrollHeight;
}

function render(analyze = true) {
  const inGame = state.mode === 'game';
  $('resign-btn').hidden = !inGame;
  $('undo-btn').hidden = inGame;
  $('new-board-btn').hidden = inGame;
  $('engine-toggle').disabled = inGame;
  $('engine-toggle').title = inGame ? 'The engine is disabled during live games for fair play.' : '';
  if (inGame) $('engine-status').textContent = 'Engine disabled during live games (fair play).';
  else if (!engineEnabled()) $('engine-status').textContent = 'Engine off.';
  renderBoard();
  renderPlayers();
  renderStatus();
  renderMoves();
  renderLobby();
  if (analyze || state.engineFen !== state.chess.fen()) requestAnalysis();
}

$('flip-btn').addEventListener('click', () => {
  state.orientation = state.orientation === 'w' ? 'b' : 'w';
  render(false);
  renderEngine();
});

$('undo-btn').addEventListener('click', () => {
  if (state.mode !== 'analysis') return;
  state.chess.undo();
  state.selected = null;
  state.targets = [];
  render();
});

$('new-board-btn').addEventListener('click', () => {
  if (state.mode !== 'analysis') return;
  state.chess = new Chess();
  state.game = null;
  state.selected = null;
  state.targets = [];
  $('game-status').textContent = '';
  render();
});

// ---------- Engine ----------

function engineEnabled() {
  return $('engine-toggle').checked && state.mode === 'analysis';
}

function setEngineEnabled(on) {
  $('engine-toggle').checked = on;
  if (on) {
    engine.start();
    requestAnalysis();
  } else {
    engine.stop();
    state.engineLines = [];
    state.engineFen = null;
    $('engine-status').textContent = 'Engine off.';
    renderEngine();
  }
}

$('engine-toggle').addEventListener('change', (e) => setEngineEnabled(e.target.checked));

function requestAnalysis() {
  if (!engineEnabled()) return;
  const fen = state.chess.fen();
  state.engineLines = [];
  state.engineFen = fen;
  renderEngine();
  if (state.chess.isGameOver()) {
    $('engine-status').textContent = 'Game over — no moves to analyse.';
    return;
  }
  $('engine-status').textContent = 'Analysing…';
  engine.analyze(fen);
}

function renderEngine() {
  const list = $('engine-lines');
  const bar = $('eval-bar');
  const lines = state.engineFen === state.chess.fen() ? state.engineLines : [];
  bar.classList.toggle('visible', engineEnabled());
  bar.classList.toggle('flipped', state.orientation === 'b');
  list.replaceChildren();
  if (!lines.length) {
    $('eval-fill').style.height = '50%';
    return;
  }
  $('eval-fill').style.height = `${scoreToPercent(lines[0].score)}%`;
  for (const line of lines) {
    const board = new Chess(state.engineFen);
    const sans = [];
    for (const uci of line.pv.slice(0, 10)) {
      try {
        sans.push(board.move(uciToMove(uci)).san);
      } catch {
        break;
      }
    }
    list.append(
      el(
        'li',
        {},
        el('span', { className: 'score', textContent: formatScore(line.score) }),
        el('span', { textContent: ` ${sans.join(' ')}` }),
        el('span', { className: 'muted', textContent: `  (d${line.depth})` }),
      ),
    );
  }
}

render();
