// Thin wrapper around the Stockfish 19 WASM engine (lite, single-threaded) running in a Web Worker.
import { parseInfoLine } from './uci.mjs';

const ENGINE_URL = '/vendor/stockfish/stockfish-19-lite-single.js';

export class Engine {
  constructor({ multiPv = 3, depth = 20, onUpdate = () => {}, onStatus = () => {} } = {}) {
    this.multiPv = multiPv;
    this.depth = depth;
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.worker = null;
    this.ready = false;
    this.searching = false;
    this.pendingFen = null;
    this.currentFen = null;
    this.lines = [];
  }

  start() {
    if (this.worker) return;
    this.onStatus('Loading Stockfish…');
    this.worker = new Worker(ENGINE_URL);
    this.worker.onmessage = (e) => this._handle(String(e.data));
    this.worker.onerror = () => this.onStatus('Failed to load Stockfish.');
    this.worker.postMessage('uci');
    this.worker.postMessage(`setoption name MultiPV value ${this.multiPv}`);
    this.worker.postMessage('isready');
  }

  stop() {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.ready = false;
    this.searching = false;
    this.pendingFen = null;
    this.currentFen = null;
    this.lines = [];
  }

  /** Requests analysis of the given position; replaces any running search. */
  analyze(fen) {
    if (!this.worker) return;
    this.pendingFen = fen;
    if (!this.ready) return;
    if (this.searching) this.worker.postMessage('stop');
    else this._startPending();
  }

  _startPending() {
    const fen = this.pendingFen;
    if (!fen) return;
    this.pendingFen = null;
    this.currentFen = fen;
    this.lines = [];
    this.searching = true;
    this.worker.postMessage(`position fen ${fen}`);
    this.worker.postMessage(`go depth ${this.depth}`);
  }

  _handle(line) {
    if (line === 'readyok') {
      this.ready = true;
      this.onStatus('Stockfish ready.');
      this._startPending();
    } else if (line.startsWith('bestmove')) {
      this.searching = false;
      if (this.pendingFen) this._startPending();
      else this.onStatus(`Analysis complete (depth ${this.depth}).`);
    } else if (line.startsWith('info ') && this.searching && !this.pendingFen) {
      const sideToMove = this.currentFen.split(' ')[1];
      const info = parseInfoLine(line, sideToMove);
      if (!info || info.bound) return;
      this.lines[info.multipv - 1] = info;
      this.onUpdate(this.currentFen, this.lines.filter(Boolean));
    }
  }
}
