import { Chess } from '/vendor/chess/chess.js';
import { Engine } from './engine.mjs';
import { formatScore, scoreToPercent, uciToMove } from './uci.mjs';

const pieceImage = (piece) => `/img/chesspieces/wikipedia/${piece}.png`;
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
  mode: 'idle',
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
  catalog: [],
  history: [],
  queued: false,
  movePending: false,
  clockReceivedAt: 0,
  registering: false,
  reviewPly: 0,
  analysisVariation: false,
};

const engine = new Engine({
  onUpdate(fen, lines) {
    if (!engineEnabled() || fen !== state.chess.fen()) return;
    state.engineFen = fen;
    state.engineLines = lines;
    renderEngine();
  },
  onStatus(text) {
    $('engine-status').textContent = text;
  },
});

async function api(url, data) {
  const response = await fetch(url, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function showError(error) { $('app-error').textContent = error.message || String(error); }
function send(event, data = {}) {
  return new Promise((resolve, reject) => {
    if (!socket.connected) return reject(new Error('Disconnected. Wait for reconnection before retrying.'));
    socket.timeout(8000).emit(event, data, (error, response) => {
      if (error) return reject(new Error('No server response. Reconnect before retrying; the action may have been accepted.'));
      if (response?.error) return reject(new Error(response.error));
      resolve(response);
    });
  });
}

$('auth-switch').addEventListener('click', () => {
  state.registering = !state.registering;
  $('onboarding').hidden = !state.registering;
  $('auth-title').textContent = state.registering ? 'Begin your quest' : 'Welcome back';
  $('auth-submit').textContent = state.registering ? 'Create account' : 'Sign in';
  $('auth-switch').textContent = state.registering ? 'Already registered? Sign in' : 'New here? Create an account';
  $('password-input').autocomplete = state.registering ? 'new-password' : 'current-password';
});
$('checkin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('checkin-error').textContent = '';
  $('auth-submit').disabled = true;
  try {
    applySession(await api(`/api/auth/${state.registering ? 'register' : 'login'}`, {
      name: $('name-input').value, password: $('password-input').value,
      experience: $('experience-input').value, rating: $('rating-input').value,
    }));
    $('password-input').value = '';
    socket.connect();
  } catch (error) { $('checkin-error').textContent = error.message; }
  finally { $('auth-submit').disabled = false; }
});

function applySession(data) {
  if (state.me && state.me.id !== data.user.id) {
    setEngineEnabled(false);
    state.game = null;
    state.mode = 'idle';
    state.chess = new Chess();
    state.reviewPly = 0;
    state.analysisVariation = false;
    state.incoming.clear();
    state.outgoing = null;
  }
  state.me = data.user;
  state.catalog = data.catalog;
  state.history = data.history;
  state.queued = data.queued;
  $('checkin').hidden = true;
  $('app').hidden = false;
  $('logout-btn').hidden = false;
  $('me').textContent = data.user.name;
  $('visibility-toggle').checked = data.user.visible;
  $('profile-stats').replaceChildren(
    el('dt', { textContent: '10+0 rating' }), el('dd', { textContent: `${data.user.rating}${data.user.provisional ? ` (provisional ${data.user.ratedGames}/${data.user.provisionalGames})` : ''}` }),
    el('dt', { textContent: 'Lifetime XP' }), el('dd', { textContent: data.user.xp }),
    el('dt', { textContent: 'Quest Rank' }), el('dd', { textContent: data.user.questRank }),
  );
  $('history').replaceChildren(...data.history.map((game) => el('li', {}, el('button', {
    className: 'secondary', textContent: `${game.white} vs ${game.black}: ${game.result}`,
    onclick: async () => {
      try {
        if (state.mode === 'game') throw new Error('Finish your active game before opening a recap.');
        const recap = await api(`/api/games/${game.gameId}`);
        if (state.mode === 'game') throw new Error('A new match started. Finish it before opening a recap.');
        receiveGame(recap);
      } catch (error) { showError(error); }
    },
  }))));
  if (data.game) receiveGame(data.game);
  else {
    if (state.mode === 'game' && state.game) {
      const previousId = state.game.gameId;
      api(`/api/games/${previousId}`).then((game) => {
        if (state.game?.gameId === previousId) receiveGame(game);
      }).catch(showError);
    }
    render();
  }
}

socket.on('connect', () => {
  $('connection').textContent = 'Connected';
  $('app-error').textContent = '';
  render();
});
socket.on('session', applySession);
socket.on('profile', applySession);
socket.on('disconnect', (reason) => {
  $('connection').textContent = 'Disconnected — clocks continue; reconnecting…';
  render();
  if (reason === 'io server disconnect') {
    setEngineEnabled(false);
    $('connection').textContent = 'Session ended. Sign in again.';
    $('checkin').hidden = false;
    $('app').hidden = true;
  }
});
socket.on('connect_error', (error) => {
  $('connection').textContent = `Connection failed: ${error.message}`;
  if (error.message.includes('Sign in')) {
    setEngineEnabled(false);
    $('checkin').hidden = false;
    $('app').hidden = true;
  }
});
setInterval(() => {
  if (socket.connected) send('presence:heartbeat').catch(showError);
}, 20_000);
$('logout-btn').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', {});
    socket.disconnect();
    location.reload();
  } catch (error) { showError(error); }
});
$('visibility-toggle').addEventListener('change', async (event) => {
  try { state.me = (await api('/api/profile/visibility', { visible: event.target.checked })).user; }
  catch (error) { event.target.checked = state.me.visible; showError(error); }
});

// ---------- Lobby ----------

socket.on('players', (players) => {
  state.players = players;
  renderLobby();
});
socket.on('lobby:state', (data) => {
  state.incoming = new Map(data.incoming.map((p) => [p.id, p.name]));
  state.outgoing = data.outgoing;
  state.queued = data.queued;
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

socket.on('challenge:declined', ({ name }) => {
  state.outgoing = null;
  setLobbyStatus(`${name} declined your challenge.`);
  renderLobby();
});

function setLobbyStatus(text) {
  $('lobby-status').textContent = text;
}

async function challenge(name) {
  try {
    await send('challenge', { name });
    state.outgoing = name;
    setLobbyStatus(`Waiting for ${name} to respond…`);
    renderLobby();
  } catch (error) { setLobbyStatus(error.message); }
}

async function cancelChallenge() {
  try {
    await send('challenge:cancel');
    state.outgoing = null;
    setLobbyStatus('');
    renderLobby();
  } catch (error) { setLobbyStatus(error.message); }
}

async function respond(fromId, accept) {
  try {
    await send('challenge:respond', { from: fromId, accept });
    state.incoming.delete(fromId);
    renderLobby();
  } catch (error) { setLobbyStatus(error.message); }
}

$('challenge-form').addEventListener('submit', (event) => {
  event.preventDefault();
  challenge($('challenge-name').value);
});
$('cancel-challenge-btn').addEventListener('click', cancelChallenge);
$('find-match-btn').addEventListener('click', async () => {
  try {
    await send('matchmaking:join');
    state.queued = state.mode !== 'game';
    setLobbyStatus(state.queued ? 'Finding a 10+0 opponent near your rating. The range expands as you wait.' : '');
    renderLobby();
  } catch (error) { setLobbyStatus(error.message); }
});
$('cancel-queue-btn').addEventListener('click', async () => {
  try { await send('matchmaking:leave'); state.queued = false; setLobbyStatus(''); renderLobby(); }
  catch (error) { setLobbyStatus(error.message); }
});

function renderLobby() {
  const inGame = state.mode === 'game';
  $('find-match-btn').disabled = inGame || state.queued || !socket.connected;
  $('cancel-queue-btn').hidden = !state.queued;
  $('cancel-challenge-btn').hidden = !state.outgoing;
  $('challenge-form').querySelector('button').disabled = inGame || !socket.connected;
  $('online-count').textContent = state.players.length;
  const list = $('players');
  list.replaceChildren();
  for (const p of state.players) {
    const isMe = p.id === state.me?.id;
    const status = el('span', {
      className: `status ${p.status}`,
      textContent: `${p.rating} · ${isMe ? '(you)' : p.status === 'in_game' ? 'in game' : 'available'}`,
    });
    const li = el('li', {}, el('span', {}, el('span', { textContent: `${p.name} ` }), status));
    if (!isMe) {
      if (state.outgoing === p.name) {
        li.append(el('button', { className: 'secondary', textContent: 'Cancel', onclick: cancelChallenge }));
      } else {
        li.append(
          el('button', {
            textContent: 'Challenge',
            disabled: inGame || p.status === 'in_game' || !socket.connected,
            onclick: () => challenge(p.name),
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

// ---------- Authoritative games ----------

function receiveGame(game) {
  if (state.game?.gameId === game.gameId && state.game.version > game.version) return;
  const starting = !game.result && (state.mode !== 'game' || state.game?.gameId !== game.gameId);
  state.mode = game.result ? 'analysis' : 'game';
  state.game = game;
  state.myColor = game.white.id === state.me.id ? 'w' : 'b';
  if (starting) {
    state.orientation = state.myColor;
    state.outgoing = null;
    state.incoming.clear();
    state.queued = false;
    setLobbyStatus('');
  }
  state.clockReceivedAt = performance.now();
  state.movePending = false;
  state.pendingPromotion = null;
  $('promotion').hidden = true;
  loadMoves(game.moves);
  state.reviewPly = game.moves.length;
  state.analysisVariation = false;
  if (!game.result) setEngineEnabled(false);
  render();
}
socket.on('game:update', receiveGame);

function loadMoves(moves) {
  const chess = new Chess();
  for (const san of moves) chess.move(san);
  state.chess = chess;
  state.selected = null;
  state.targets = [];
}

$('resign-btn').addEventListener('click', () => {
  if (state.mode !== 'game' || !confirm('Resign this game?')) return;
  gameAction('resign');
});
function gameAction(action, data = {}) {
  return send(`game:${action}`, { gameId: state.game.gameId, ...data }).catch(showError);
}
$('draw-btn').addEventListener('click', () => gameAction('offerDraw'));
$('claim-draw-btn').addEventListener('click', () => {
  const move = $('move-input').value;
  if (move && !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) return showError(new Error('Enter a legal coordinate move, or clear the input to claim the current position.'));
  gameAction('claimDraw', move ? {
    version: state.game.version, from: move.slice(0, 2), to: move.slice(2, 4), ...(move[4] ? { promotion: move[4] } : {}),
  } : {});
});
$('accept-draw-btn').addEventListener('click', () => gameAction('respondDraw', { accept: true }));
$('decline-draw-btn').addEventListener('click', () => gameAction('respondDraw', { accept: false }));
$('rematch-btn').addEventListener('click', () => challenge(state.game[state.myColor === 'w' ? 'black' : 'white'].name));
$('guess-form').addEventListener('submit', (event) => {
  event.preventDefault();
  gameAction('guess', { questId: $('guess-picker').value });
});
$('move-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('move-input').value;
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value)) return showError(new Error('Enter a move such as e2e4 or e7e8q.'));
  makeMove({ from: value.slice(0, 2), to: value.slice(2, 4), ...(value[4] ? { promotion: value[4] } : {}) });
  $('move-input').value = '';
});

// ---------- Board ----------

let board;
let dropHandledClick = false;

$('board').addEventListener('click', (event) => {
  if (dropHandledClick) return;
  const square = event.target.closest('[data-square]');
  if (square) onSquareClick(square.dataset.square);
});

new ResizeObserver(() => {
  if (board && !$('app').hidden) {
    board.resize();
    renderBoard();
  }
}).observe($('board-area'));

function createBoard() {
  return Chessboard('board', {
    position: state.chess.fen(),
    orientation: state.orientation === 'b' ? 'black' : 'white',
    pieceTheme: pieceImage,
    draggable: true,
    onDragStart(source) {
      const piece = state.chess.get(source);
      return !state.pendingPromotion && canMove() && piece?.color === state.chess.turn();
    },
    onDrop(from, to) {
      dropHandledClick = true;
      setTimeout(() => { dropHandledClick = false; }, 0);
      if (from === to) {
        // chessboard.js intercepts piece clicks as same-square drops.
        onSquareClick(from);
        return 'snapback';
      }
      const moves = state.chess.moves({ square: from, verbose: true }).filter((move) => move.to === to);
      if (!canMove() || state.pendingPromotion || !moves.length) return 'snapback';
      if (moves.some((move) => move.promotion)) {
        showPromotion(from, to);
        return 'snapback';
      }
      makeMove({ from, to });
    },
    onSnapEnd: renderBoard,
    onSnapbackEnd: renderBoard,
  });
}

function canMove() {
  if (state.mode === 'analysis') return true;
  return state.mode === 'game' && socket.connected && !state.movePending && !state.game.result && state.chess.turn() === state.myColor;
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
        className: 'promotion-piece',
        title: { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[p],
        onclick: () => {
          box.hidden = true;
          state.pendingPromotion = null;
          makeMove({ from, to, promotion: p });
        },
      }, el('img', { src: pieceImage(`${color}${p.toUpperCase()}`), alt: p.toUpperCase() })),
    ),
  );
  box.hidden = false;
}

async function makeMove(move) {
  if (!canMove()) return showError(new Error('You cannot move right now.'));
  state.selected = null;
  state.targets = [];
  if (state.mode === 'game') {
    state.movePending = true;
    try { await send('game:move', { gameId: state.game.gameId, version: state.game.version, ...move }); }
    catch (error) { showError(error); }
    finally { state.movePending = false; render(false); }
  } else {
    let played;
    try { played = state.chess.move(move); }
    catch { return showError(new Error('Illegal analysis move.')); }
    if (!state.analysisVariation && played.san === state.game.moves[state.reviewPly]) state.reviewPly++;
    else state.analysisVariation = true;
  }
  render();
}

function lastMove() {
  const history = state.chess.history({ verbose: true });
  return history[history.length - 1] || null;
}

function renderBoard() {
  if ($('app').hidden) return;
  if (!board) board = createBoard();
  const orientation = state.orientation === 'b' ? 'black' : 'white';
  if (board.orientation() !== orientation) board.orientation(orientation);
  board.position(state.chess.fen(), false);
  const grid = state.chess.board();
  const last = lastMove();
  const targetSquares = new Map(state.targets.map((m) => [m.to, m]));
  const checkedKing =
    state.chess.inCheck() &&
    grid.flat().find((p) => p && p.type === 'k' && p.color === state.chess.turn())?.square;
  for (const node of $('board').querySelectorAll('[data-square]')) {
    const square = node.dataset.square;
    const target = targetSquares.get(square);
    node.classList.toggle('last', Boolean(last && (last.from === square || last.to === square)));
    node.classList.toggle('selected', state.selected === square);
    node.classList.toggle('target', Boolean(target));
    node.classList.toggle('capture', Boolean(target && (state.chess.get(square) || target.flags.includes('e'))));
    node.classList.toggle('check', checkedKing === square);
  }
}

function renderPlayers() {
  const turn = state.chess.turn();
  const label = (color) => {
    let name = color === 'w' ? 'White' : 'Black';
    if (state.game) name = `${state.game[color === 'w' ? 'white' : 'black'].name} (${name})`;
    const node = el('span', { textContent: name });
    if (state.mode === 'game' && !state.game.result && turn === color) node.append(el('span', { className: 'turn', textContent: ' ●' }));
    const clock = el('time', { className: 'clock', id: `clock-${color}` });
    return el('div', { className: 'player-label' }, node, clock);
  };
  const bottom = state.orientation;
  const top = bottom === 'w' ? 'b' : 'w';
  $('top-player').replaceChildren(label(top));
  $('bottom-player').replaceChildren(label(bottom));
  renderClocks();
}

function renderStatus() {
  if (state.game?.result) {
    $('game-status').textContent = `${RESULT_TEXT[state.game.result]} by ${state.game.reason}.`;
    return;
  }
  if (state.mode !== 'game') return;
  const c = state.chess;
  let text = c.turn() === state.myColor ? 'Your move.' : 'Waiting for your opponent…';
  if (c.inCheck()) text = `Check! ${text}`;
  $('game-status').textContent = text;
}

function renderClocks() {
  if (!state.game) return;
  for (const color of ['w', 'b']) {
    const running = state.mode === 'game' && state.game.turn === color;
    const remaining = Math.max(0, state.game.clocks[color] - (running ? performance.now() - state.clockReceivedAt : 0));
    const seconds = Math.ceil(remaining / 1000);
    const node = $(`clock-${color}`);
    if (node) {
      node.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      node.classList.toggle('running', running);
    }
  }
}
setInterval(renderClocks, 100);

function renderQuests() {
  const game = state.game;
  $('quest-panel').hidden = !game || Boolean(game.result);
  if (!game || game.result) return;
  $('own-quests').replaceChildren(...game.ownQuests.map((q) => el('li', {
    className: q.completedAtPly !== null ? 'completed' : '',
    textContent: `${q.title} · ${q.level} · ${q.baseXp} XP${q.completedAtPly !== null ? ` — completed on ply ${q.completedAtPly}` : ' — in progress'}`,
  })));
  $('guess-count').textContent = `${game.guessesRemaining} of ${game.guessLimit} guesses remaining. The clock keeps running.`;
  const previous = $('guess-picker').value;
  $('guess-picker').replaceChildren(...state.catalog.filter((q) => q.enabled).map((q) => el('option', {
    value: q.questId, textContent: `${q.title} (${q.level})`,
    disabled: game.guesses.some((g) => g.questId === q.questId),
  })));
  if ([...$('guess-picker').options].some((option) => option.value === previous && !option.disabled)) $('guess-picker').value = previous;
  $('guess-btn').disabled = game.guessesRemaining === 0 || !socket.connected;
  $('guesses').replaceChildren(...game.guesses.map((g) => el('li', {
    textContent: `${state.catalog.find((q) => q.questId === g.questId)?.title}: ${g.correct ? `Correct! ${game.guessXp} base XP pending eligibility.` : 'Not correct or no longer eligible.'}`,
  })));
  $('revealed-quests').replaceChildren(...game.revealedQuests.map((q) => el('li', {
    textContent: `Revealed: ${q.title}${q.completedAtPly !== null ? ' (now completed)' : ' (still in progress)'}`,
  })));
}

function renderRecap() {
  const game = state.game;
  $('recap').hidden = !game?.recap;
  if (!game?.recap) return;
  const recap = game.recap;
  $('recap').replaceChildren(el('h2', { textContent: 'Mission debrief' }),
    el('p', { textContent: `${RESULT_TEXT[game.result]} · ${game.reason} · ${game.moves.length} plies` }),
    el('p', { className: 'muted', textContent: recap.xpEligible ? `Quest XP awarded. Rating is calculated independently using Elo K=${game.eloK}.` : `No XP awarded: ${recap.flags.join(', ')}. Chess rating is calculated independently.` }));
  for (const player of Object.values(recap.players)) {
    const section = el('section', { className: 'recap-player' },
      el('h3', { textContent: player.name }),
      el('p', { textContent: `Rating ${player.ratingBefore} → ${player.ratingAfter} (${player.ratingDelta >= 0 ? '+' : ''}${player.ratingDelta}) · +${player.total} XP · Lifetime ${player.totalXp} XP` }));
    for (const q of player.quests) {
      section.append(el('p', { textContent: `${q.title}: ${q.completedAtPly === null ? 'not completed' : `completed at ply ${q.completedAtPly}, ${q.evidence.san} (${q.evidence.uci})`}` }));
      if (q.evidence) section.append(el('details', {}, el('summary', { textContent: 'Completion evidence' }),
        el('p', { className: 'evidence', textContent: `At ${new Date(q.completedAt).toISOString()} · FEN ${q.evidence.fen}` })));
    }
    section.append(el('p', { textContent: `Guesses: ${player.guesses.length ? player.guesses.map((g) => `${g.questId} ${g.correct ? 'correct' : 'incorrect/ineligible'} at ${new Date(g.submittedAt).toISOString()}`).join('; ') : 'none'}` }));
    section.append(el('p', { textContent: `XP events: ${player.events.map((e) => `${e.source} ${e.questId} +${e.baseAmount}`).join(', ') || 'none'} · multiplier ×${player.multiplier} · final ${player.total} (rounded down once; eligibility applied).` }));
    $('recap').append(section);
  }
}

function renderMoves() {
  const history = state.mode === 'analysis' ? state.game.moves : state.chess.history();
  const list = $('moves');
  const moveNode = (san, ply) => {
    const node = el('span');
    if (!san) return node;
    if (!engineEnabled()) {
      node.textContent = san;
      return node;
    }
    const button = el('button', {
      className: 'move-link',
      textContent: san,
      onclick: () => seekMove(ply),
    });
    button.setAttribute('aria-label', `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '...'} ${san}`);
    if (!state.analysisVariation && state.reviewPly === ply) button.setAttribute('aria-current', 'step');
    node.append(button);
    return node;
  };
  list.replaceChildren();
  for (let i = 0; i < history.length; i += 2) {
    list.append(
      el(
        'li',
        {},
        moveNode(history[i], i + 1),
        moveNode(history[i + 1], i + 2),
      ),
    );
  }
  const selected = list.querySelector('[aria-current="step"]');
  list.scrollTop = selected ? selected.offsetTop - list.clientHeight / 2 + selected.offsetHeight / 2
    : engineEnabled() && state.reviewPly === 0 ? 0 : list.scrollHeight;
}

function renderReviewControls() {
  const enabled = engineEnabled();
  $('review-controls').hidden = !enabled;
  if (!enabled) return;
  const total = state.game.moves.length;
  $('review-first').disabled = state.reviewPly === 0 && !state.analysisVariation;
  $('review-previous').disabled = state.reviewPly === 0 && !state.analysisVariation;
  $('review-next').disabled = state.reviewPly === total;
  $('review-last').disabled = state.reviewPly === total && !state.analysisVariation;
  $('review-position').textContent = state.analysisVariation
    ? 'Analysis variation. Use the arrows or move list to return to the recorded game.'
    : `Position ${state.reviewPly} of ${total} · ${state.reviewPly === 0 ? 'Starting position' : `${Math.ceil(state.reviewPly / 2)}${state.reviewPly % 2 ? '.' : '...'} ${state.game.moves[state.reviewPly - 1]}`}`;
}

function seekMove(ply) {
  if (state.mode !== 'analysis' || !state.game?.result) return;
  state.reviewPly = Math.max(0, Math.min(state.game.moves.length, ply));
  state.analysisVariation = false;
  state.pendingPromotion = null;
  $('promotion').hidden = true;
  loadMoves(state.game.moves.slice(0, state.reviewPly));
  render();
}

function stepReview(direction) {
  if (!engineEnabled()) return;
  seekMove(state.reviewPly + (state.analysisVariation && direction < 0 ? 0 : direction));
}
$('review-first').addEventListener('click', () => { if (engineEnabled()) seekMove(0); });
$('review-previous').addEventListener('click', () => stepReview(-1));
$('review-next').addEventListener('click', () => stepReview(1));
$('review-last').addEventListener('click', () => { if (engineEnabled()) seekMove(state.game.moves.length); });
document.addEventListener('keydown', (event) => {
  if (!engineEnabled() || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || event.target.isContentEditable || event.target.closest('input, textarea, select')) return;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Home') seekMove(0);
  else if (event.key === 'End') seekMove(state.game.moves.length);
  else stepReview(event.key === 'ArrowLeft' ? -1 : 1);
});

function render(analyze = true) {
  const inGame = state.mode === 'game';
  $('resign-btn').hidden = !inGame;
  $('draw-btn').hidden = !inGame;
  $('draw-btn').disabled = Boolean(state.game?.drawOffer);
  $('claim-draw-btn').hidden = !inGame;
  const opponentOffer = inGame && state.game.drawOffer && state.game.drawOffer !== state.myColor;
  $('accept-draw-btn').hidden = !opponentOffer;
  $('decline-draw-btn').hidden = !opponentOffer;
  $('move-form').hidden = !inGame;
  $('move-form').querySelector('button').disabled = !canMove();
  $('undo-btn').hidden = state.mode !== 'analysis';
  $('rematch-btn').hidden = !state.game?.result;
  $('analysis-panel').hidden = state.mode !== 'analysis';
  $('engine-toggle').disabled = inGame;
  $('engine-toggle').title = inGame ? 'The engine is disabled during live games for fair play.' : '';
  if (inGame) $('engine-status').textContent = 'Engine disabled during live games (fair play).';
  else if (!engineEnabled()) $('engine-status').textContent = 'Engine off.';
  renderBoard();
  renderPlayers();
  renderStatus();
  renderReviewControls();
  renderMoves();
  renderLobby();
  renderQuests();
  renderRecap();
  if (analyze || state.engineFen !== state.chess.fen()) requestAnalysis();
}

$('flip-btn').addEventListener('click', () => {
  state.orientation = state.orientation === 'w' ? 'b' : 'w';
  render(false);
  renderEngine();
});

$('undo-btn').addEventListener('click', () => {
  if (state.mode !== 'analysis') return;
  if (!state.analysisVariation) {
    seekMove(state.reviewPly - 1);
    return;
  }
  state.chess.undo();
  state.analysisVariation = state.chess.history().length !== state.reviewPly;
  state.selected = null;
  state.targets = [];
  render();
});

// ---------- Engine ----------

function engineEnabled() {
  return $('engine-toggle').checked && state.mode === 'analysis';
}

function setEngineEnabled(on) {
  $('engine-toggle').checked = on;
  if (on) {
    requestAnalysis();
  } else {
    engine.stop();
    state.engineLines = [];
    state.engineFen = null;
    $('engine-status').textContent = 'Engine off.';
    renderEngine();
  }
  renderReviewControls();
  renderMoves();
}

$('engine-toggle').addEventListener('change', (e) => setEngineEnabled(e.target.checked));

function requestAnalysis() {
  if (!engineEnabled()) return;
  const fen = state.chess.fen();
  state.engineLines = [];
  state.engineFen = fen;
  renderEngine();
  if (!state.chess.moves().length) {
    engine.stop();
    $('engine-status').textContent = state.chess.isCheckmate() ? 'Checkmate — no legal moves to evaluate.' : 'Stalemate — no legal moves to evaluate.';
    return;
  }
  engine.start();
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

try {
  const response = await fetch('/api/me');
  if (response.ok) {
    applySession(await response.json());
    socket.connect();
  } else if (response.status !== 401) {
    throw new Error('Could not restore your session. Refresh to retry.');
  }
} catch (error) { showError(error); }
