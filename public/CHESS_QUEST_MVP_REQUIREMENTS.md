# Chess Quest — MVP Engineering Requirements

**Status:** Implementation-ready draft for GitHub Copilot  
**Source:** Chess Quest Vision & MVP PRD (10-minute edition), October 27, 2026  
**Priority:** P0 unless otherwise stated  
**Product promise:** *Win the board. Uncover the mission.*

**Requirements update (October 27, 2026):** Keep the player's quest and opponent-guess action visible beside or directly below the board without page scrolling. Offer exactly 10 quest options, including exactly one correct answer, with one guess per player per game. A correct, timely guess earns 5 base XP, subject to the existing result multiplier. These rules supersede the earlier two-attempt / 15-XP defaults.

> **Instruction to coding agent:** Implement the requirements below in the existing repository's conventions. First inspect the repository and summarize the proposed architecture, migrations, and milestones. Do not assume a framework, database, or auth provider. Prefer established, maintained chess rules libraries over custom rule engines. Ask before irreversible infrastructure changes. Do not treat illustrative APIs or data structures below as mandatory.

## 1. MVP scope and invariants

- **Exactly one game mode:** every human-vs-human game includes hidden quests and opponent deduction. Do not create separate Classic/Quest Duel modes.
- **Exactly one time control:** **10+0 rapid** — each player starts with 600 seconds, **no increment**. No 5-minute, bullet, classical, or time-control selector in the MVP.
- **Two authenticated human players** per rated match. Each receives **one or two** private objectives from a library of **20 seed quests**, organized into **Easy / Medium / Hard**.
- Play standard legal chess. The game outcome is decided by chess rules and clock, **not** by quest XP.
- Chess **rating**, lifetime **XP**, and **Quest Rank** are distinct concepts. Matchmaking uses rating, never XP.
- A player may make **one guess per game** of the opponent's **uncompleted** secret objective, choosing from **exactly 10 options containing exactly one correct answer**. A correct, timely guess earns **5 base XP** and reveals the guessed objective to the guessing player.
- During play, the player's own quest(s) and a clearly labelled **Guess opponent's quest** action must be visible beside or directly below the board, without page scrolling.
- On game completion, show the chess result, rating change, objectives, guesses, and XP breakdown.
- All moves, clocks, quest outcomes, guesses, XP, and rating updates are **server authoritative**. Clients never declare their own successes.

## 2. Personas and user journeys

1. **New player:** Register → choose display name → indicate experience (beginner / casual / intermediate / advanced; optional external rating as unverified input) → enter lobby → see online presence → start a 10+0 match → receive private quest(s) → play → view recap.
2. **Returning player:** Sign in → see profile, 10+0 rating, XP, Quest Rank and online players → join matchmaking or accept a friend challenge.
3. **In-game player:** Make legal moves under the clock; track own quests beside or directly below the board without scrolling; use the prominently visible guess action to choose once from 10 options; see private correct/incorrect feedback and any pending bonus XP; reconnect if connection drops.
4. **Postgame player:** See full reveal and independently calculated XP and rating changes.

## 3. Functional requirements and acceptance criteria

### AUTH-01 — Identity and authentication

- Register, sign in, sign out, and maintain a persistent unique `userId`.
- Store a unique display name and basic profile; use the repository's existing auth provider if present.
- Only authenticated users can enter rated matchmaking, issue guesses, or play rated games.
- Protect routes and websocket/session actions from unauthorized access.
- Never expose passwords, session secrets, or private quest payloads to other users.

**Accept when:** a signed-out user cannot join a match; a returning user retains identity, rating, XP and history.

### PRES-01 — Live online presence

- Track `online`, `in_game`, and `offline` separately from whether an account exists or has logged in historically.
- Presence is based on authenticated live connections / heartbeat and server-side expiry; stale sessions become offline.
- Show an online count and a list of online players with display name and relevant availability status.
- Default privacy-safe behavior: allow players to hide from the public online directory while remaining eligible to play if they explicitly join matchmaking.
- Handle multiple tabs/devices without incorrectly marking a user offline when one tab closes.

**Accept when:** unexpected disconnect eventually expires presence; joining a match updates availability; privacy settings are respected.

### MATCH-01 — Matchmaking and challenges

- Provide **Find Match** queue for 10+0 only, using a provisional or established 10+0 chess rating.
- Expand allowed rating range gradually as queue wait increases (exact bands configurable).
- Provide invite/challenge flow for a known player as a low-liquidity fallback.
- Prevent matching a user to themselves or assigning one user to two active rated games.
- A match starts only when two authenticated users are committed and both private quest assignments are persisted.
- Matchmaking and challenge acceptance must be race-safe.

**Accept when:** two eligible players are paired once; simultaneous accept requests do not create duplicate games.

### GAME-01 — Chess rules and authoritative gameplay

- Use a tested chess rules engine for legal moves, turn order, check, checkmate, stalemate, threefold/fivefold repetition where applicable, fifty-/seventy-five-move rules where applicable, insufficient material, promotion, castling, and en passant.
- Persist move history (SAN and/or UCI), current FEN, turn, result, and timestamps.
- Each clock starts at **600,000 ms**, decreases only while that player's clock runs, and has no increment.
- Enforce timeouts on the server; account for reconnects and client latency without trusting client clock values.
- Support resignation and draw by agreement; apply standard chess draw/timeout rules.
- Support reconnecting to an active game with correct board, clock, private quest and guess state.
- Display board orientation, legal moves, clocks, last move, game result, and connection status.

**Accept when:** illegal/out-of-turn/stale moves are rejected; simultaneous moves are serialized; server and clients converge after reconnect.

### QUEST-01 — One unified quest-enabled mode

- Assign **1–2** objectives to each player before the first move. For initial launch, default to **1 per player** unless configuration enables 2; never assign more than 2.
- Store quest assignments privately; only the owner can see their full assigned objectives until revealed through a valid guess or postgame recap.
- Avoid incompatible, impossible, or trivially self-defeating quest combinations; validate assignment eligibility against starting position and configured level.
- A quest is optional to winning the game, but every match has quest assignments.
- Display the player's assigned quest title(s), progress and completion state in the board's immediate play area: beside the board on wider screens or directly below it on narrower screens. Keep these visible while playing without requiring page scrolling, opening another screen or expanding a collapsed panel.
- Prioritize the board, clocks, own quests and opponent-guess action over profile, lobby, history and analysis content in the active-game layout. Resize/reflow the board as needed rather than pushing the quest controls below the viewport.

**Accept when:** every match has private objectives and no public game-mode switch exists; the player can read their quest(s) and progress beside or directly below the board without scrolling in the active-game layout at desktop (1280 x 720) and mobile portrait (390 x 844) viewport sizes.

### QUEST-02 — Quest definitions and validation

- Implement a data-driven quest catalog with stable `questId`, title, level, base XP, eligibility, and a deterministic server-side validation function.
- Evaluate quest conditions after **accepted legal moves**, using board state and move history; do not trust client events.
- Store `completedAtPly`, `completedAt`, and evidence (move/position reference) exactly once per quest.
- The 20 seed quests are listed in §5. Some require precise tactical semantics; **do not mark an ambiguous validator as complete until its exact rule is documented and tested**.
- If a quest cannot be validated correctly, disable its assignment until the validator is ready; do not fake completions.

**Accept when:** replaying the same legal move sequence produces identical quest completions, with no duplicate XP.

### GUESS-01 — Opponent deduction

- Show an easily visible, clearly labelled **Guess opponent's quest** action beside or directly below the board, alongside the player's own quest(s). It must not be hidden below the lobby/history, in an off-screen side panel, or behind an unrelated menu.
- Opening this action presents **exactly 10 distinct, selectable quest options**. Exactly **one** option must match an opponent assignment; the other **nine** must be decoys that do not match any of that opponent's assigned quests. If two quests are assigned to the opponent, include only one of them in the option set.
- Generate, randomize and persist each player's option set server-side before the first move. Retain the same set and order across reconnects and tabs; never let a client request fresh options to enumerate the catalog. Only option IDs/titles are sent, with no correct-answer flag or opponent-assignment metadata.
- Decoy titles may come from the 20-seed catalog even when their validators are not yet enabled. This does **not** make those quests assignable or bypass QUEST-02's validator gate. Do not reduce the list below 10, duplicate options, or expose availability metadata that singles out the correct answer.
- **MVP rule:** each player gets **exactly one guess attempt per game total**, shared across all tabs/devices and all opponent objectives. Do not provide extra attempts through configuration in this MVP.
- A guess is valid only while the game is active and the targeted opponent objective is **not completed**.
- Correct guess: record it, reserve **5 base XP** for finalization under XP-01, and reveal that objective to the guesser; the opponent continues to pursue it and the guesser can counterplay. Immediately display a private, prominent confirmation such as **Correct! +5 base XP**, explaining that the final award depends on the result multiplier and reward eligibility.
- Incorrect guess: consume the player's only attempt, display clear private incorrect feedback, award no guess bonus, and do not reveal opponent objectives.
- After either correct or incorrect submission, show **Guess used** and the recorded outcome, and disable further submissions. Refreshing, reconnecting or opening another tab must not restore the attempt.
- A guess does not pause either chess clock. Enforce authenticated, rate-limited, server-timestamped guess submission.
- Reject option IDs outside that player's persisted 10-option set, additional/repeated guesses, guesses after completion, and guesses after game end. Late/completed-objective failures must not reveal private assignments or grant the bonus. The one-correct-option guarantee identifies an actual assignment; it does not override the requirement to guess before that objective is completed.

**Accept when:** the quest and guess action are visible without page scrolling at the viewport sizes specified in QUEST-01; opening the picker shows exactly 10 distinct choices with exactly one opponent assignment; one submission uses the only attempt across all tabs/reconnects; correct guesses immediately show success and a pending 5-base-XP bonus; incorrect guesses show failure and no bonus; the opponent's unrevealed objective cannot be inferred from normal API payloads; concurrent move/guess events resolve deterministically on the server.

### XP-01 — XP and progression

- Base XP for completed objectives depends on difficulty; guessing bonus is separate.
- **Quest completion defaults:** Easy = 20 XP, Medium = 40 XP, Hard = 60 XP. A correct pre-completion guess earns **5 base XP**, separately identified as a guess event.
- Proposed end-of-game multiplier applied to eligible earned XP: **win ×2, draw ×1, loss ×0.5**.
- The guess bonus is **base XP**, not a flat final award: it contributes 10 XP on a win, 5 XP on a draw, or 2.5 XP before final rounding on a loss. Sum eligible quest and guess base XP, apply the result multiplier, then round down once; a guess-only loss therefore awards 2 XP. Existing reward-eligibility and anti-farming rules still apply.
- Calculate fractional outcomes deterministically (e.g., round down once at final award); keep a detailed immutable XP ledger.
- Award only once when the game is finalized; repeated result events must be idempotent.
- Keep total XP nonnegative and Quest Rank as a separate derived progression label. **Provisional rank thresholds:** Level 1: 0 XP, Level 2: 200 XP, Level 3: 500 XP; keep configurable.
- Apply anti-farming caps/flags to suspicious repeated opponent games; do not silently award XP for abandoned or invalid games without a documented policy.

**Accept when:** a finished match's XP is reproducible from validated events, correct guesses contribute exactly one 5-base-XP event, and win/draw/loss multipliers and final rounding work as documented.

### RATING-01 — Chess skill rating

- Maintain **one 10+0 rating** per player (no separate blitz/classical ratings).
- Initialize provisionally from onboarding self-assessment, optionally informed by a user-entered external rating, which is **unverified**.
- Use an established rating algorithm (e.g., Glicko-2 or Elo) selected consistently for the whole MVP; document parameters and provisional behavior.
- Update ratings from eligible finalized chess outcomes only; quest completions and XP do not affect chess rating.
- Avoid duplicate rating changes on retries and ensure both players' updates are transactionally consistent.

**Accept when:** a player can gain XP while losing rating, and rating is unaffected by number of quests completed.

### RECAP-01 — Postgame summary

- Show winner/draw and reason, move history, before/after rating, both players' quest assignments and completion evidence, guesses, earned XP by event, multiplier, and total XP.
- Reveal the opponent's quests only when the game is finalized (except those already correctly guessed).
- Preserve recap access in the player's game history.

**Accept when:** recap matches server records and is available after reconnect.

### REVIEW-01 — Postgame evaluation and move navigation

- Retain **chessboard.js** for board visuals and **Stockfish 19** for evaluation. Postgame evaluation is an explicit exception to the general exclusion of AI analysis; evaluation and review controls must not be available during an active rated game.
- Once evaluation is enabled, show clearly labelled backward/forward arrow controls directly below the board, plus first/last-position controls. Disable controls at the corresponding beginning/end boundary.
- Show the current review position as **Position X of Y**, where X counts half-moves and position 0 is the starting position. Include the selected move's number and SAN when X is greater than 0.
- Allow users to select a recorded move from the full move list and highlight the selected move. Support Left/Right arrow keys and Home/End without intercepting typing or navigation within form fields.
- Display the selected position on the board, including its last-move/check highlights, and evaluate that position with Stockfish 19. Rapid navigation must not display stale evaluation lines for another position.
- At checkmate or stalemate, show an explicit no-legal-moves evaluation status while keeping backward navigation available. Returning to an earlier position with legal moves must resume evaluation.
- Browsing moves must preserve the complete recorded move list and must not mutate server records, result, clocks, quests, guesses, XP, rating or recap. Temporary analysis variations must not overwrite the recorded game; navigation must allow returning to it.
- Hide navigation when evaluation is disabled. Preserve access when opening a completed game from history; returning to active play must stop the engine and hide review controls in every tab.

**Accept when:** after enabling evaluation, a user can browse from the final position to the starting position and back, select individual moves, and see evaluation for each selected legal position without losing the recorded game. Verify boundary controls, keyboard/form-field behavior, rapid navigation, analysis-variation recovery, terminal positions, history access and active-game fair-play restrictions.

### SAFE-01 — Basic safety, fairness and abuse controls

- Validate all mutations server-side; enforce authorization by game participant.
- Rate-limit auth, matchmaking, move, and guess endpoints; prevent guessing by brute-force enumeration.
- Prevent XP farming via repeat-opponent caps and suspicious-game flags; provide operational logging.
- Use idempotent game finalization, atomic XP/rating updates, and replay-safe event processing.
- Do not permit third-party engines or move advice in rated play; no client-side hidden-objective data leaks.
- Apply minimal privacy controls for presence and profiles.

**Accept when:** forged completion/guess events and unauthorized access attempts fail automated tests.

## 4. Screens / UI deliverables

1. **Authentication:** sign up / sign in / sign out.
2. **Onboarding:** experience selection, optional unverified external rating.
3. **Lobby:** online-player count/list, availability, Find Match, friend challenge.
4. **Game:** board, clock, own secret objectives and progress immediately beside or below the board, a prominently visible **Guess opponent's quest** action in the same no-scroll play area, a picker with exactly 10 distinct options and exactly one correct answer, **1 guess remaining / Guess used** state, immediate private guess feedback, connection state, resign/draw. Profile/lobby/history must not push the quest and guess controls outside the viewport.
5. **Postgame:** reveal, XP breakdown, chess result, rating delta, rematch/navigation, and optional Stockfish 19 evaluation with board-adjacent backward/forward and first/last move navigation per REVIEW-01.
6. **Profile/history:** display name, 10+0 rating, XP, Quest Rank, recent games.

All UI must be responsive, keyboard-accessible where practical, and communicate errors and reconnect state clearly. The quest text and guess action must remain visible together with the board at the QUEST-01 acceptance viewport sizes. The picker may use an accessible dialog or an adjacent panel, but opening and submitting it must not require navigating away from the game; any option-list scrolling must stay within the picker, not require scrolling the page to find the action.

## 5. Seed quest library (20)

Difficulty levels are **initial product classifications**, not verified estimates. Definitions below identify the intended mechanic; tactical conditions require explicit validator specs and tests.

| ID | Level | Quest | Validation intent |
|---|---|---|---|
| E01 | Easy | Knight captures bishop | Player's knight legally captures enemy bishop |
| E02 | Easy | Bishop captures knight | Player's bishop legally captures enemy knight |
| E03 | Easy | Rook captures bishop | Player's rook legally captures enemy bishop |
| E04 | Easy | Castle queenside | Player legally castles long |
| E05 | Easy | Force a queen trade | Both queens exchanged in an objectively defined sequence; **needs formal definition** |
| E06 | Easy | Create a passed pawn | Player has a passed pawn after their move, not merely at initial state |
| M01 | Medium | Win material with knight fork | Knight attacks 2+ qualifying targets and wins material; **needs formal definition** |
| M02 | Medium | Win material with bishop fork | Bishop attacks 2+ qualifying targets and wins material; **needs formal definition** |
| M03 | Medium | Win material with pawn fork | Pawn attacks 2+ qualifying targets and wins material; **needs formal definition** |
| M04 | Medium | Execute rook skewer | Rook skewer yields tactical gain; **needs formal definition** |
| M05 | Medium | Execute bishop skewer | Bishop skewer yields tactical gain; **needs formal definition** |
| M06 | Medium | Pin a knight to queen | Knight is pinned relative to queen; **needs formal definition** |
| M07 | Medium | Pin a piece to king | Absolute pin against king; **needs formal definition** |
| M08 | Medium | Capture en passant | Player legally executes en passant |
| H01 | Hard | Discover an attack on queen | Player move reveals attack on opponent queen; **needs formal definition** |
| H02 | Hard | Deliver a double check | Legal move results in two simultaneous checks |
| H03 | Hard | Win a piece via discovered attack | Discovered attack yields capture; **needs formal definition** |
| H04 | Hard | Promote a pawn | Player legally promotes a pawn |
| H05 | Hard | Deliver checkmate with rook | Final checkmating move made by rook; define promoted rook handling |
| H06 | Hard | Win a piece by removing its defender | Removal of defender causes material win; **needs formal definition** |

**Implementation gate:** Fully specify and test the unambiguous validators first. Before releasing all 20 as assignable, formalize the tactical predicates for every marked quest. No placeholder validators in production.

## 6. Suggested domain model (adapt to repository)

- `User`: `id`, `displayName`, `authProviderId`, `createdAt`, `presenceVisibility`
- `PlayerStats`: `userId`, `rapid10Rating`, `ratingDeviation?`, `isProvisional`, `totalXp`, `questRank`
- `PresenceSession`: `sessionId`, `userId`, `lastSeenAt`, `status`, `expiresAt`
- `MatchQueueEntry`: `userId`, `joinedAt`, `ratingSnapshot`, `status`
- `Game`: `id`, `whiteUserId`, `blackUserId`, `timeControl=600`, `status`, `fen`, `moveNumber`, `whiteTimeMs`, `blackTimeMs`, `lastClockAt`, `result`, `terminationReason`, `version`
- `Move`: `gameId`, `ply`, `uci`, `san`, `fenAfter`, `acceptedAt`
- `QuestDefinition`: `id`, `level`, `xp`, `validatorKey`, `enabled`
- `QuestAssignment`: `gameId`, `userId`, `questId`, `completedAtPly?`, `evidence?`
- `GuessOptionSet`: `gameId`, `guesserId`, ten distinct ordered `questIds`, `createdAt`; persist before play, with exactly one matching opponent assignment. Any answer-key/reference metadata remains server-only.
- `Guess`: `gameId`, `guesserId`, `questId`, `submittedAt`, `correct`, `revealedAssignmentId?`
- `XpLedger`: `eventId`, `gameId`, `userId`, `source`, `baseAmount`, `multiplier`, `finalAmount`
- `RatingChange`: `gameId`, `userId`, `before`, `after`

Use database constraints for unique active matches, per-game move sequence, unique quest completions, one option set and at most one submitted guess per player/game, and unique game-finalization rewards. Do not expose `QuestAssignment` records or guess answer keys in public game serializers.

## 7. Suggested server actions / events (illustrative)

| Action / event | Purpose |
|---|---|
| `auth.*` | Sign up, login, logout using existing auth |
| `presence.heartbeat` / `presence.updated` | Refresh and broadcast permitted online state |
| `matchmaking.join` / `.leave` / `match.found` | Queue for 10+0 |
| `challenge.create` / `.accept` / `.decline` | Direct player challenge |
| `game.snapshot` | Authorized board/clock state, **own** quests, that player's persisted 10-option set, and one-guess availability/outcome; no answer key |
| `game.move` / `game.moveAccepted` | Validated chess move and clock update |
| `game.guessObjective` / `game.guessResolved` | Private guess request and result |
| `game.resign` / `game.offerDraw` / `game.respondDraw` | Game conclusion actions |
| `game.finished` | Final result and public postgame reveal |
| `game.recap` | XP/rating breakdown for authorized participants |

Use HTTPS for initial requests and a reliable real-time transport (e.g., WebSocket) for play. Add sequence numbers and game versions to avoid out-of-order event application.

## 8. Quality, reliability and security tests

- Chess rules: all special moves, illegal moves, checkmate, stalemate, draws, promotion, timeout.
- Concurrency: both players move at once, duplicate packets, reconnect, disconnect, clock race, move vs. guess ordering.
- Privacy: opponent cannot retrieve private quests before reveal; hidden directory user not listed.
- Quest engine: deterministic replay, no duplicate completion, boundary cases and false positives for all enabled quests.
- Guess options: exactly 10 distinct options, exactly one matching opponent assignment even with two opponent quests, nine nonmatching decoys, no answer-key/availability metadata leaks, stable options/order across tabs and reconnects, and out-of-set IDs rejected. Disabled validators must never become assignable just to fill the picker.
- Guessing: correct/incorrect feedback, one attempt total, concurrent submissions from multiple tabs, duplicate/replayed packets, late/completed objectives, exhausted attempt after reconnect, wrong player, game already finished, and no clock pause.
- XP/rating: exactly one 5-base-XP event for a correct timely guess, zero for incorrect/late guesses, win/draw/loss multipliers and round-down-once behavior (including a guess-only loss awarding 2 XP), duplicate finalization, farming restrictions, no rating changes from quests.
- Active-game layout: at 1280 x 720 desktop and 390 x 844 mobile portrait, quest titles/progress and the guess action are visible beside or directly below the board without page scrolling. Verify keyboard access, visible success/failure feedback, and guess controls remaining discoverable after reconnect.
- Postgame review: first/previous/next/last controls and boundary states, clickable full move list with selection highlight, keyboard navigation without hijacking form fields, correct board and Stockfish FEN at each selected ply (including special moves), rapid navigation, variation recovery, terminal-position handling, immutable server recap, and controls hidden when evaluation is off or a rated game starts.
- Presence: heartbeat expiry, multiple tabs, privacy, in-game transition.
- End-to-end: register → match → see quest and guess action without scrolling → open the 10-option picker → submit the only guess before the target objective completes → see immediate success/failure → play/complete quest → finalize → recap showing the 5-base-XP event and final multiplied award when correct → enable Stockfish 19 evaluation → browse backward/forward and select recorded moves → verify evaluation follows the selected position and the saved game is unchanged.

## 9. Implementation milestones

1. **Foundation:** inspect repo; architecture proposal; auth, profile, schema, migrations, automated test setup.
2. **Real-time chess:** online presence, lobby, pairing/challenges, 10+0 server-clocked legal game, reconnect.
3. **Quest engine:** catalog, assignment privacy, deterministic validators, objective progress.
4. **Deduction and progression:** persistent 10-option guessing with exactly one correct answer, one attempt per player/game, visible private feedback, 5-base-XP guess event, XP ledger, rating updates, recap, anti-abuse.
5. **Release gate:** automated E2E, postgame move-browsing/evaluation and no-scroll quest/guess layout tests, load/concurrency smoke tests, privacy review, staging deployment instructions.

For each milestone, supply working code, tests, migration notes, and a short list of remaining blockers.

## 10. Decisions and assumptions to confirm

**Confirmed quest visibility and guessing rules (October 27, 2026):**

- Own quest(s) and progress visible immediately beside or below the board without page scrolling.
- An easily visible **Guess opponent's quest** action in the same board-adjacent play area.
- Exactly 10 distinct options, with exactly one correct answer and nine decoys.
- Exactly one guess attempt per player per game, including across tabs/devices/reconnects.
- Immediate private feedback on a correct or incorrect guess.
- Correct timely guess: **5 base XP**, subject to the existing win/draw/loss multiplier, final rounding and reward eligibility. This replaces the earlier 15-XP value.

**Confirmed move-browsing requirements (October 27, 2026):**

- Enable postgame evaluation to display previous/next arrows and first/last-position controls directly below the chessboard.js board.
- Browse the entire recorded game, including the starting position, without deleting moves or changing the saved result, recap or progression.
- Click individual moves in the complete move list, highlight the selected move, and show **Position X of Y**.
- Support Left/Right and Home/End shortcuts without interfering with form fields.
- Evaluate the selected position with Stockfish 19; discard stale evaluation output after navigation and show explicit terminal-position feedback.
- Allow returning from temporary analysis variations to the recorded game. Hide browsing controls when evaluation is off, and stop evaluation/hide controls in all tabs when rated play starts.

The following other proposed defaults and decisions are unchanged by this requirements update:

- One quest per player initially; optionally two via configuration.
- Quest completion XP: 20 / 40 / 60 for Easy / Medium / Hard; guess bonus is specified above.
- Quest Rank thresholds: 0 / 200 / 500 XP initially.
- Default presence visibility and friend challenge privacy.
- Rating algorithm and provisional placement rules.
- XP handling for resignations, abandonment, early draws, and suspected farming.
- Exact tactical validator rules for ambiguous seed quests.

**Out of scope for MVP:** 5-minute games, bullet, classical, multiple game modes, guilds, tournaments, lessons, AI move advice during rated play (postgame Stockfish 19 evaluation/review is allowed under REVIEW-01), imported PGN progression, paid subscriptions, and mobile-native apps.
