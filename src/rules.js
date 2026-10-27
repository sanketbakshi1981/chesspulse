'use strict';

// Tune these launch rules for future games; active games snapshot reward rules.
module.exports = Object.freeze({
  xpByLevel: Object.freeze({ Easy: 20, Medium: 40, Hard: 60 }),
  guessXp: 15,
  multipliers: Object.freeze({ win: 2, draw: 1, loss: 0.5 }),
  rankThresholds: Object.freeze([0, 200, 500]),
  eloK: 32,
  provisionalGames: 5,
  minRewardPlies: 10,
  dailyOpponentCap: 3,
});
