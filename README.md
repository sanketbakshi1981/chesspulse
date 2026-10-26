# chesspulse
A website for people to come in and play chess and have lots of fun learning the game

## Features (MVP)

- **Check in with a name.** You don't need an account. Names must be unique among the players who are online right now.
- **Live lobby.** See who is online and whether each player is available or already in a game.
- **Challenge anyone online.** The other player gets a prompt to accept or decline. Colours are picked at random.
- **Real-time games** over WebSockets (Socket.IO). The server checks every move with [chess.js](https://github.com/jhlywa/chess.js). It detects checkmate, stalemate and the draw rules. You can resign, and if a player leaves the page their opponent wins.
- **Stockfish 19 analysis.** The engine comes from the [`stockfish`](https://www.npmjs.com/package/stockfish) npm package (lite, single-threaded WASM build) and runs in each browser in a Web Worker. It costs nothing to run and puts no load on the server. It shows the top 3 lines with evaluations and an evaluation bar.
  - For fair play, the engine is turned off during live games. Once a game ends you can analyse it, and you can always open a free analysis board.

## Running locally

Requires Node.js 18+.

```bash
npm install
npm start          # http://localhost:3000  (set PORT to change)
npm test           # unit + socket integration tests
```

Open the site in two browser windows (or on two devices), check in with different names, and challenge each other.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/server.js` | Express + Socket.IO server; serves `public/`, chess.js and the Stockfish files |
| `src/lobby.js` | In-memory lobby: online players, challenges, games, move validation |
| `public/app.mjs` | Browser UI: check-in, lobby, board, live play |
| `public/engine.mjs` | Stockfish Web Worker wrapper (UCI) |
| `public/uci.mjs` | UCI output parsing / score formatting helpers |
| `test/` | `node:test` test suites |

State lives only in memory, so restarting the server clears all players and games.

## License

Stockfish is licensed under GPL-3.0, so this project is distributed under GPL-3.0 as well.
