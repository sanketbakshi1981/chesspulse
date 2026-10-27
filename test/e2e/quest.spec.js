'use strict';

const { test, expect } = require('@playwright/test');
const { Chess } = require('chess.js');

async function register(page, name, rating) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.locator('#name-input').fill(name);
  await page.locator('#password-input').fill('browser-test-password');
  await page.locator('#rating-input').fill(rating);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.locator('#me')).toHaveText(name);
  await expect(page.locator('#connection')).toHaveText('Connected');
}
async function keyboardMove(page, move) {
  await page.locator('#move-input').fill(move);
  await expect(page.getByRole('button', { name: 'Play move', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Play move', exact: true }).click();
}

test('register, match, complete quest, guess, reconnect, recap and evaluate with Stockfish 19', async ({ browser, baseURL }) => {
  const first = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL });
  const a = await first.newPage();
  const b = await second.newPage();
  const errors = [];
  for (const page of [a, b]) page.on('pageerror', (error) => errors.push(error.message));
  await a.addInitScript(() => {
    window.enginePositions = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...options) {
        if (typeof message === 'string' && message.startsWith('position fen ')) window.enginePositions.push(message.slice(13));
        return super.postMessage(message, ...options);
      }
    };
  });
  try {
    await register(a, 'BrowserAlice', '1250');
    await register(b, 'BrowserBob', '1250');
    await expect(a.locator('#profile-stats')).toContainText('1250 (provisional 0/5)');
    await expect(a.locator('#visibility-toggle')).not.toBeChecked();
    await a.getByRole('button', { name: 'Find match · 10+0' }).click();
    await b.getByRole('button', { name: 'Find match · 10+0' }).click();
    for (const page of [a, b]) {
      await expect(page.locator('#own-quests')).toContainText('Capture en passant');
      await expect(page.locator('#analysis-panel')).toBeHidden();
      await expect(page.locator('#review-controls')).toBeHidden();
      await expect(page.locator('#board img')).toHaveCount(32);
    }
    await a.locator('#guess-picker').selectOption('M08');
    await a.getByRole('button', { name: 'Guess objective', exact: true }).click();
    await expect(a.locator('#guesses')).toContainText('Correct!');
    await b.locator('#guess-picker').selectOption('M08');
    await b.getByRole('button', { name: 'Guess objective', exact: true }).click();
    await expect(b.locator('#guesses')).toContainText('Correct!');
    const moves = ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6', 'c7d6', 'g1f3', 'g8f6', 'f1e2', 'b8c6'];
    for (const [ply, move] of moves.entries()) {
      await keyboardMove(ply % 2 ? b : a, move);
      await expect(a.locator('#moves span')).toHaveCount(ply % 2 ? ply + 1 : ply + 2);
    }
    await expect(a.locator('#own-quests')).toContainText('completed on ply 5');
    await a.reload();
    await expect(a.locator('#connection')).toHaveText('Connected');
    await expect(a.locator('#own-quests')).toContainText('completed on ply 5');
    await expect(a.locator('#guesses')).toContainText('Correct!');
    a.once('dialog', (dialog) => dialog.accept());
    await a.getByRole('button', { name: 'Resign', exact: true }).click();
    await expect(a.locator('#recap')).toContainText('Mission debrief');
    await expect(a.locator('#recap')).toContainText('+27 XP');
    await expect(a.locator('#profile-stats')).toContainText('1234 (provisional 1/5)');
    await expect(b.locator('#recap')).toContainText('+30 XP');
    await expect(a.locator('#analysis-panel')).toBeVisible();
    await a.locator('#engine-toggle').check();
    await expect(a.locator('#engine-lines li').first()).toBeVisible({ timeout: 45_000 });
    await expect(a.locator('#engine-lines')).toContainText(/depth|d\d+/);
    const gameId = (await (await a.request.get('/api/me')).json()).history[0].gameId;
    const recorded = await (await a.request.get(`/api/games/${gameId}`)).json();
    const expectPosition = async (ply) => {
      const chess = new Chess();
      for (const move of moves.slice(0, ply)) chess.move(move);
      const expected = Object.fromEntries(chess.board().flat().filter(Boolean)
        .map((piece) => [piece.square, piece.color + piece.type.toUpperCase()]));
      await expect(a.locator('#review-position')).toContainText(`Position ${ply} of ${moves.length}`);
      await expect.poll(() => a.locator('#board [data-square]').evaluateAll((squares) => Object.fromEntries(
        squares.filter((square) => square.querySelector('img')).map((square) => [
          square.dataset.square, square.querySelector('img').dataset.piece,
        ]),
      ))).toEqual(expected);
      await expect(a.locator('#moves span')).toHaveCount(moves.length);
      await expect.poll(() => a.evaluate(() => window.enginePositions.at(-1))).toBe(chess.fen());
    };
    await expect(a.getByRole('button', { name: 'Next move', exact: true })).toBeDisabled();
    await a.getByRole('button', { name: 'Previous move', exact: true }).click();
    await expectPosition(9);
    await expect(a.locator('#moves [aria-current="step"]')).toHaveText('Be2');
    await a.getByRole('button', { name: 'First position', exact: true }).click();
    await expectPosition(0);
    await expect(a.getByRole('button', { name: 'Previous move', exact: true })).toBeDisabled();
    await a.keyboard.press('ArrowRight');
    await expectPosition(1);
    await a.locator('#challenge-name').focus();
    await a.keyboard.press('ArrowLeft');
    await expect(a.locator('#review-position')).toContainText('Position 1 of 10');
    await a.locator('#moves button').nth(4).click();
    await expectPosition(5);
    await a.getByRole('button', { name: 'Next move', exact: true }).click();
    await expectPosition(6);
    await a.getByRole('button', { name: 'Previous move', exact: true }).click();
    await a.getByRole('button', { name: 'Next move', exact: true }).click();
    await a.getByRole('button', { name: 'Next move', exact: true }).click();
    await expectPosition(7);
    await a.keyboard.press('Home');
    await expectPosition(0);
    await a.locator('#board [data-square="d2"]').click();
    await a.locator('#board [data-square="d4"]').click();
    await expect(a.locator('#review-position')).toContainText('Analysis variation');
    await expect(a.locator('#moves span')).toHaveCount(10);
    await a.getByRole('button', { name: 'Previous move', exact: true }).click();
    await expectPosition(0);
    await a.getByRole('button', { name: 'Next move', exact: true }).click();
    await expectPosition(1);
    await a.keyboard.press('End');
    await expectPosition(10);
    await a.getByRole('button', { name: 'Analysis: undo', exact: true }).click();
    await expectPosition(9);
    await a.getByRole('button', { name: 'Last position', exact: true }).click();
    await expectPosition(10);
    expect(await (await a.request.get(`/api/games/${gameId}`)).json()).toEqual({
      ...recorded, serverNow: expect.any(Number),
    });
    await a.locator('#engine-toggle').uncheck();
    await expect(a.locator('#review-controls')).toBeHidden();
    await a.reload();
    await expect(a.locator('#history button')).toHaveCount(1);
    await a.locator('#history button').click();
    await expect(a.locator('#recap')).toContainText('+27 XP');
    const otherTab = await first.newPage();
    otherTab.on('pageerror', (error) => errors.push(error.message));
    await otherTab.goto('/');
    await expect(otherTab.locator('#connection')).toHaveText('Connected');
    await otherTab.locator('#history button').click();
    await a.locator('#engine-toggle').check();
    await otherTab.locator('#engine-toggle').check();
    await a.getByRole('button', { name: 'Find match · 10+0' }).click();
    await b.getByRole('button', { name: 'Find match · 10+0' }).click();
    for (const page of [a, otherTab]) {
      await expect(page.locator('#own-quests')).toBeVisible();
      await expect(page.locator('#analysis-panel')).toBeHidden();
      await expect(page.locator('#engine-toggle')).not.toBeChecked();
      await expect(page.locator('#engine-toggle')).toBeDisabled();
      await expect(page.locator('#review-controls')).toBeHidden();
    }
    for (const [ply, move] of ['f2f3', 'e7e5', 'g2g4', 'd8h4'].entries()) {
      await keyboardMove(ply % 2 ? b : a, move);
    }
    await expect(a.locator('#game-status')).toContainText('checkmate');
    await a.locator('#engine-toggle').check();
    await expect(a.locator('#engine-status')).toContainText('Checkmate');
    await expect(a.locator('#review-position')).toContainText('Position 4 of 4');
    await a.getByRole('button', { name: 'Previous move', exact: true }).click();
    await expect(a.locator('#review-position')).toContainText('Position 3 of 4');
    await expect(a.locator('#engine-lines li').first()).toBeVisible({ timeout: 45_000 });
    expect(errors).toEqual([]);
  } finally { await first.close(); await second.close(); }
});

test('mobile onboarding and lobby have no horizontal overflow and sign-out is usable', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await register(page, 'MobilePlayer', '');
    await expect(page.locator('#profile-stats')).toContainText('1000');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('#checkin')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
  } finally { await context.close(); }
});
