'use strict';

module.exports = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, salt TEXT NOT NULL, experience TEXT NOT NULL,
    external_rating INTEGER, rating INTEGER NOT NULL, xp INTEGER NOT NULL DEFAULT 0 CHECK(xp>=0),
    rated_games INTEGER NOT NULL DEFAULT 0, visible INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at BIGINT NOT NULL
  );
  CREATE TABLE games (id TEXT PRIMARY KEY, data TEXT NOT NULL, finished INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE active_players (
    user_id TEXT PRIMARY KEY REFERENCES users(id), game_id TEXT NOT NULL REFERENCES games(id)
  );
  CREATE TABLE moves (
    game_id TEXT NOT NULL REFERENCES games(id), ply INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(game_id,ply)
  );
  CREATE TABLE quest_completions (
    game_id TEXT NOT NULL REFERENCES games(id), user_id TEXT NOT NULL REFERENCES users(id),
    quest_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(game_id,user_id,quest_id)
  );
  CREATE TABLE guesses (
    game_id TEXT NOT NULL REFERENCES games(id), user_id TEXT NOT NULL REFERENCES users(id),
    quest_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(game_id,user_id,quest_id)
  );
  CREATE TABLE xp_ledger (
    game_id TEXT NOT NULL REFERENCES games(id), user_id TEXT NOT NULL REFERENCES users(id),
    data TEXT NOT NULL, PRIMARY KEY(game_id,user_id)
  );
  CREATE TABLE rating_changes (
    game_id TEXT NOT NULL REFERENCES games(id), user_id TEXT NOT NULL REFERENCES users(id),
    "before" INTEGER NOT NULL, "after" INTEGER NOT NULL, PRIMARY KEY(game_id,user_id)
  );
`;
