# questoc

**Little Chess, Big Adventures**

Authenticated, rated human-vs-human chess with secret objectives and opponent
deduction. There is one game mode and one time control: **10+0 rapid**.
Chess decides the result; quests earn separate lifetime XP and Quest Rank.

The kid-friendly lobby puts total XP and Quest Rank up front, with one primary
**Start a quest** action and friend invites nearby. Profile information
expand only when needed. The online directory is always visible in the lobby,
updates live, and lists every connected, signed-in player automatically, including
yourself. Multiple tabs count as one player. Below the online player list, the lobby
shows the total number of registered accounts in smaller italic text for reference, including offline players,
updated from the database on sign-in, session restore and live lobby updates.
The board appears during a
game and stays visible at completion, on desktop and mobile. During play, secret quests and
their base XP stay beside or directly below the board. The recap celebrates
earned XP and signed chess rating changes beside the board (directly below on
mobile), with a collapsible quest/reward breakdown. Return to the lobby to start
another adventure; game history reopens the board and its recorded rewards.
Accounts, database paths and existing deployment resource names are unchanged.
The current XP rules and compatibility policy are documented below.

## Run and test

Requires **Node.js 22.13+** with built-in `node:sqlite` (tested on Node 24).
Some supported Node releases print an experimental SQLite warning.

```bash
npm install
npm start                         # http://localhost:3000
npm test                          # domain, rules, auth, persistence, socket tests
npx playwright install chromium   # once per test environment
npm run test:e2e                  # real Chromium + actual Stockfish WASM evaluation
```

Sign up in two separate browser profiles/incognito contexts to play as two
different people. Tabs sharing cookies belong to the same account.
Registration requires a username and password. The username is also the public
display name and is used to sign in; existing accounts keep their names.
Tests use
isolated databases, not the application database. Browser tests start and stop
their own server on port 4317; set `E2E_PORT` if that port is occupied.

In GitHub Codespaces, run `npm start` and open forwarded port **3000** from the
Ports panel. Port **4317** belongs to the temporary browser-test server and stops
when tests finish; do not use that preview to sign in. Development automatically
accepts the exact HTTPS forwarded origin for the current Codespace and app port.
Production still requires `APP_ORIGIN`. Sign-in stays disabled until the app's
JavaScript loads; forms never send credentials in the URL.

If sign-in reports an empty or unreadable server response, retry once, then
restart `npm start` and open the URL printed in that terminal. Check the terminal
for server errors if the problem persists. These messages include the HTTP
status and indicate a response problem, not necessarily incorrect credentials.

## Architecture and migration

The app retains Express, Socket.IO and **chess.js** for standard chess rules.
**chessboard.js** renders the board with locally served jQuery and piece images.
**Stockfish 19** (`stockfish-19-lite-single.js` + WASM) runs in a browser Web
Worker **only for postgame evaluation**, an explicit exception to the PRD's
out-of-scope AI analysis item. Starting a rated game stops evaluation in every
connected tab; engine assets require authentication and reject active players.
No separate classic mode, bot games or free analysis-board mode is offered.

After a game, enable **Stockfish 19** to show move-navigation arrows directly
below the board. Step backward/forward, jump to the first/last position, or
click a move in the full recorded move list. Left/Right arrow keys and Home/End
also navigate, except while editing a form field. The selected move is
highlighted and Stockfish evaluates that position. Analysis moves are temporary
variations; navigation returns to the recorded game without changing its
history, result, clocks, quests, XP or rating. Navigation is hidden when
evaluation is off and during rated play.

| Component | Responsibility |
| --- | --- |
| [src/server.js](src/server.js) | HTTP auth/profile/recap API, authenticated Socket.IO, rate limits and participant-only broadcasts |
| [src/store.js](src/store.js) | SQLite schema migration, password hashes, sessions, atomic persistence |
| [src/lobby.js](src/lobby.js) | Presence, rating queue, challenges, clocks, chess, deduction, finalization and private serialization |
| [src/quests.js](src/quests.js) | Twenty seed definitions, assignment eligibility and enabled deterministic validators |
| [src/rules.js](src/rules.js) | Tunable XP, ranks, Elo, provisional games and reward eligibility defaults |
| [public/app.mjs](public/app.mjs) | Auth/onboarding, profile/history, lobby, chessboard.js interactions, clocks, quests and recap |
| [public/engine.mjs](public/engine.mjs) | Stockfish 19 UCI worker wrapper |

On first startup, schema version 1 is created transactionally. The previous
guest lobby had only in-memory identities and games; there is no guest account
or rating migration. Existing assets are retained. The read-only requirements
attachment is not modified.

Data defaults to `data/chessquest.sqlite` (ignored by Git). Users, hashed sessions,
games/private assignments, move records, quest completion evidence, guesses,
immutable XP ledgers and rating changes persist. Database constraints enforce
unique names, one active game per player, unique move plies, quest completions,
guesses and per-player finalization records. Both players' rewards, stats,
finished game and active-player removal commit in one transaction. A failed
write rolls back the entire action, not just one player's reward.

Clocks survive process restarts and continue through downtime; the next action
or maintenance tick finalizes expired games. Presence, queues and outstanding
challenges are intentionally ephemeral. Clients reconnect with the same account,
board, private objectives, guesses and clock. Disconnecting or signing out does
not immediately forfeit: the server clock keeps running.

## Identity, ratings and privacy

- Register with a unique display name and a 10-128 character password. Passwords
  use salted scrypt; raw session tokens are never stored. Seven-day sessions use
  HttpOnly, SameSite=Strict cookies (Secure in production).
- Experience is onboarding context. An optional **rating textbox** accepts
  whole numbers from 100 to 3000; blank means 1000. This is explicitly
  **self-reported/unverified**. Chess.com/Lichess linking is deferred.
- One rapid rating uses **Elo K=32**:
  `expectedWhite = 1 / (1 + 10^((blackRating-whiteRating)/400))`;
  `whiteDelta = round(32 * (whiteScore-expectedWhite))`, and black gets the
  opposite delta. Equally rated players gain/lose 16 for a decisive result.
- The first **five** eligible completed games are provisional. K remains 32
  during and after provisional status. Quests and XP never affect chess rating.
- Every connected, signed-in player appears in the online directory automatically.
  Counts include yourself, deduplicate tabs/devices and exclude offline accounts.
  The former directory-hiding preference no longer applies, including for existing
  accounts; its legacy database column is retained unused, without a migration.
  Old clients calling the retired visibility endpoint receive an explicit HTTP 410
  asking them to refresh. Use a nickname rather than your real name.
- Presence uses authenticated connections, transport heartbeat and a 20-second
  application heartbeat with 60-second expiry. Closing one of several tabs does
  not mark the account offline.
- Matchmaking starts within 100 rating points, widening by 100 every 15 seconds
  of the older player's wait. It never uses XP. These bands are constructor
  options on `Lobby`; challenge acceptance and queue pairing share the same
  transactional game creation path.

## Gameplay and deduction

- Each side starts at **600,000 ms**, no increment. Only the player to move loses
  time. The server uses receipt time, never client-supplied clock values; browser
  clocks extrapolate the latest authoritative snapshot for smooth display.
  There is no client-controlled lag compensation or clock pause.
- Legal moves, check/mate, castling, en passant and all promotions use chess.js.
  Stalemate and conventional insufficient material draw automatically.
  Threefold repetition and fifty-move draws are **claimed**; fivefold repetition
  and seventy-five moves are automatic, with checkmate taking precedence.
  For a claim on an intended move, enter its coordinate form in the keyboard
  move input, then select **Claim rule draw** without playing it. Clear the
  input to claim the current position.
- Resignation, draw offer/accept/decline and server timeout are supported.
  Timeout is a draw when the non-flagging side lacks possible mating material,
  considering both sides' material and bishop square colors. As with common
  material-based library predicates, exotic forced dead positions/fortresses
  are not exhaustively solved; do not claim a full FIDE dead-position solver.
- Move versions reject stale/duplicate submissions; synchronous server actions
  serialize move/guess/timeout races. Only participants can access game records.
- One private quest per side by default; `QUEST_COUNT=2` enables two distinct
  enabled objectives. All assignments are for standard starting positions.
  The enabled set has no mutually exclusive pairs.
- Two guesses per game by default, configurable via `GUESS_LIMIT` (1-10). Only
  enabled catalog IDs are candidates. Repeated, excessive, postgame, unknown-ID
  and too-frequent submissions are rejected. There is at least one second
  between attempts, plus a six-requests-per-minute transport limit.
- A correct guess of an **uncompleted** objective privately reveals it and
  earns pending guess XP, without stopping either clock or the objective.
  A completed-objective submission cannot succeed. It consumes an attempt and
  has the **same failed-attempt response as an unassigned objective** so errors
  do not become an oracle for completed private assignments. This privacy-safe
  interpretation of "reject completed guesses" also prevents free enumeration.
- No snapshot contains unguessed opponent assignments or opponent guesses
  during play. The recap reveals both sides only after transactional finalization.
  Errors and reconnect state are shown; coordinate entry supports keyboard play.

## Quest validator specifications

The seed catalog has all **20** requested IDs, titles and levels.
**Nine are assignable**; eleven ambiguous tactical quests remain disabled,
not placeholder-completed. Each enabled validator is tested with a legal
positive example and a near miss. Evaluation only follows an accepted move.
Completion timestamps, ply and SAN/UCI/FEN evidence are written once.

| ID | Exact enabled predicate |
| --- | --- |
| E01 | Moving piece is a knight and captured piece is an enemy bishop |
| E02 | Moving piece is a bishop and captured piece is an enemy knight |
| E03 | Moving piece is a rook and captured piece is an enemy bishop |
| E04 | Legal move has the queenside-castling flag |
| E06 | After the mover's move, an own pawn has no enemy pawn ahead on its file or adjacent files, but the corresponding pawn was not passed before the move; compare a moved pawn to its original square. Moving an already-passed pawn does not qualify |
| M08 | Legal move has the en-passant capture flag |
| H02 | Resulting opponent king is in check and attacked by at least two of the mover's pieces |
| H04 | Legal move promotes to queen, rook, bishop or knight |
| H05 | The moving piece was already a rook and the resulting position is checkmate. A previously promoted rook qualifies; the promotion move itself does not |

E05, M01-M07, H01, H03 and H06 are disabled until queen-trade, material-gain,
fork/skewer/pin/discovery/removal-of-defender semantics have precise approved
definitions and false-positive tests. Do not enable them merely to fill the
catalog.

## XP, Quest Rank and anti-farming

Launch rules are centralized in [src/rules.js](src/rules.js). Games snapshot
their reward/guess/Elo parameters so later tuning does not reinterpret active
matches. Quest assignments persist their base XP.

- Easy/Medium/Hard completions: **20/40/60** base XP; successful guess: **10**.
- Eligible base events are summed, multiplied by **win x2 / draw x1 / loss x0.5**,
  with no rounding needed: all new base awards are multiples of 10. A guess-only
  loss/draw/win earns exactly **5/10/20 XP**. Rewards are not applied before
  finalization. Older active games keep their saved reward amounts and legacy
  rounding; historical ledgers are not rewritten.
- Lifetime XP remains nonnegative. Quest Rank thresholds are **0 / 200 / 500**
  (Level 1/2/3), independently of chess rating.
- No XP for fewer than **10 plies**, explicit server abandonment, or after
  **three XP-eligible games against the same opponent per UTC day**. Eligible
  games count toward that cap even if nobody completes a quest. Flags are
  recorded in the ledger/recap and operational logs.
- Normal chess results, including resignations, agreement draws and timeouts,
  update rating even if XP is withheld. Explicit server abandonment would
  update neither rating nor the provisional game count; routine reconnects
  and restarts are not abandonment.
- Recaps include result/reason, move list, both assignments and evidence,
  guess titles/outcomes, rating before/after, XP events, multiplier, eligibility
  flags, final award and lifetime total. They remain accessible in game history.
  Exact guess timestamps remain in server records, not in the displayed recap.

This is basic repeat-opponent protection, not comprehensive collusion/Sybil or
external-engine detection. Server validation rejects forged completions and
unauthorized actions, but cannot prevent a person using another device's engine.

## Deployment and operations

Use **one Node process** with a durable local SQLite volume. In-process
presence/queue ownership is not designed for multiple workers. Do not deploy
this as stateless replicas or put the database on an unreliable network share.

| Setting | Default |
| --- | --- |
| `PORT` | `3000` |
| `DATABASE_PATH` | `data/chessquest.sqlite` |
| `QUEST_COUNT` | `1`, only `1` or `2` allowed |
| `QUEST_LEVEL` | `all`, or `Easy` / `Medium` / `Hard` |
| `GUESS_LIMIT` | `2`, integer 1-10 |
| `APP_ORIGIN` | `http://<request Host>` for local development; set the exact public HTTPS origin behind a proxy |
| `NODE_ENV` | Set `production` for Secure cookies |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | Set `PGHOST` to use PostgreSQL instead of local SQLite; default port `5432` |
| `PGSSLMODE` | `verify-full`; `disable` is allowed only for non-production local testing |

### Deploy to Azure

See the [cost-conscious Azure deployment guide](infra/README.md) for a
single-instance Linux App Service B1 and managed PostgreSQL B1ms deployment,
public database connectivity restricted by firewall, verified TLS and live price checks.
There is no container registry, VNet, private DNS or keep-awake queue.
The [Bicep template](infra/main.bicep) creates the infrastructure; the
[publish script](infra/publish.sh) deploys the app without uploading local data.
The [GitHub Actions workflow](.github/workflows/azure.yml) tests changes and
automatically deploys successful pushes to `main` using passwordless Azure OIDC;
complete the production environment setup in the deployment guide first.
No Azure resources are created merely by running the app or tests.

PostgreSQL uses the same schema and atomic game/reward transactions as SQLite.
Database access is asynchronous; an application action queue preserves move,
matchmaking and timeout serialization. A PostgreSQL session advisory lock
prevents multiple app processes from sharing the database while presence and
queues remain in memory. Deploy a single worker and App Service instance, not a cluster.
PostgreSQL integration tests use `npm run test:postgres` against a disposable
database, as described in the deployment guide.

For staging:

1. Provision Node 22.13+ and a persistent writable database directory.
2. Set `NODE_ENV=production`, `APP_ORIGIN=https://your-staging-host`,
   `DATABASE_PATH` and `PORT`; terminate TLS at a trusted reverse proxy and
   forward Socket.IO upgrades.
3. Install with `npm ci`; run unit/socket and browser tests separately from the
   production database, then start with `npm start`.
4. Probe `/healthz`; verify two real browsers can register, pair, reconnect and
   retrieve the same recap. Confirm secure cookies and public-origin checks.
5. Restrict database file access to the application account. Back up with
   SQLite's online backup facilities, or stop the process before copying the
   database (including WAL state). Exercise restoration before release.
6. Monitor explicit request/socket/maintenance errors and reward eligibility
   logs. Arrange process supervision, TLS renewal and disk-space alerts.

The simplified Central US deployment uses a new `chessquest-appservice-centralus`
resource group and starts with an empty database. Existing Container Apps resources
are not deleted automatically; follow the migration checklist before removing them.
Regional availability and cloud deployment status must be checked in Azure;
local tests alone do not establish production readiness.

## Milestones and remaining release gates

1. **Foundation:** local accounts, profile, SQLite migration and persistent
   sessions implemented. No guest data migration is needed. Production account
   recovery and external rating verification are not implemented.
2. **Real-time chess:** private presence, rating queue/challenges, 10+0 clocks,
   versioned legal moves and reconnect implemented. Unit/socket tests include
   duplicate packets and a ten-client/five-match concurrency smoke test, not a
   production capacity benchmark.
3. **Quests:** all 20 catalog entries; nine specified/tested validators.
   The remaining eleven are intentionally release-gated.
4. **Deduction/progression:** private guessing, immutable XP ledger, independent
   Elo, rollback-safe finalization, farming caps and persistent recaps implemented.
5. **Verification:** automated real-browser registration -> match -> guess ->
   legal quest completion -> reconnect -> finalization -> history -> actual
   Stockfish 19 evaluation; mobile overflow/sign-out checks and privacy/auth tests.
   Independent production privacy/security review, staging acceptance, realistic
   load testing and exhaustive exotic dead-position adjudication remain gates.

## License

Stockfish is GPL-3.0; this project is distributed under GPL-3.0.
chessboard.js and jQuery are MIT-licensed. Wikipedia piece images are from
the chessboard.js v1.0.0 distribution; its license is preserved at
`public/img/chesspieces/LICENSE.chessboardjs.md`.
