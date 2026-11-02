'use strict';

const { test, expect } = require('@playwright/test');
const { Chess } = require('chess.js');

async function register(page, name, rating) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  const username = page.getByLabel('Username', { exact: true });
  const password = page.getByLabel('Password', { exact: true });
  await expect(username).toHaveAttribute('required', '');
  await expect(username).toHaveAttribute('autocomplete', 'username');
  await expect(password).toHaveAttribute('required', '');
  await expect(password).toHaveAttribute('type', 'password');
  await expect(password).toHaveAttribute('autocomplete', 'new-password');
  await username.fill(name);
  await password.fill('browser-test-password');
  await page.locator('#rating-input').fill(rating);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.locator('#me')).toHaveText(name);
  await expect(page.locator('#connection')).toHaveText('Connected');
}
async function keyboardMove(page, move) {
  if (!await page.locator('#move-input').isVisible()) await page.locator('#game-tools summary').click();
  await page.locator('#move-input').fill(move);
  await expect(page.getByRole('button', { name: 'Play move', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Play move', exact: true }).click();
}

test('sign-in cannot submit credentials when app JavaScript fails to load', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (request) => requests.push({ url: request.url(), method: request.method() }));
  try {
    await page.route('**/app.mjs', (route) => route.abort());
    await page.goto('/');
    await expect(page.locator('#auth-submit')).toBeDisabled();
    await expect(page.locator('#auth-switch')).toBeDisabled();
    await expect(page.locator('#checkin-error')).toContainText('check that the app server is running');
    await expect(page.locator('#checkin-form')).toHaveAttribute('method', 'post');
    await expect(page.locator('#checkin-form')).toHaveAttribute('action', '/api/auth/login');
    await page.getByLabel('Username', { exact: true }).fill('OfflinePlayer');
    await page.getByLabel('Password', { exact: true }).fill('not-a-real-password');
    await page.getByLabel('Password', { exact: true }).press('Enter');
    expect(page.url()).toBe(`${baseURL}/`);
    expect(requests.some((request) => request.method === 'POST' || request.url.includes('name=') || request.url.includes('password='))).toBe(false);
  } finally { await context.close(); }
});

test('sign-in remains unavailable with JavaScript disabled', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.locator('#auth-submit')).toBeDisabled();
    await expect(page.locator('noscript p')).toBeVisible();
    await expect(page.locator('noscript p')).toHaveText('Please enable JavaScript to sign in and play questoc.');
    await expect(page.locator('#checkin-form')).toHaveAttribute('method', 'post');
  } finally { await context.close(); }
});

test('sign-in explains empty or invalid responses and allows a successful retry', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await register(page, 'LoginRecovery', '');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('#checkin')).toBeVisible();
    await page.getByLabel('Username', { exact: true }).fill('LoginRecovery');
    await page.getByLabel('Password', { exact: true }).fill('browser-test-password');
    for (const response of [
      { status: 200, body: '', message: 'empty response' },
      { status: 502, body: '', message: 'empty response' },
      { status: 200, body: '{"user":', message: 'unreadable response' },
      { status: 503, body: '<html>Unavailable</html>', message: 'unreadable response' },
      { status: 200, body: 'null', message: 'unexpected response' },
      { status: 200, body: '[]', message: 'unexpected response' },
    ]) {
      await page.route('**/api/auth/login', (route) => route.fulfill({
        status: response.status, contentType: 'application/json', body: response.body,
      }));
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.locator('#checkin-error')).toContainText(response.message);
      await expect(page.locator('#checkin-error')).toContainText(`HTTP ${response.status}`);
      await expect(page.locator('#checkin-error')).not.toContainText('JSON');
      await expect(page.locator('#app')).toBeHidden();
      await expect(page.locator('#auth-submit')).toBeEnabled();
      await page.unroute('**/api/auth/login');
    }
    await page.getByLabel('Password', { exact: true }).fill('incorrect-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#checkin-error')).toHaveText('Invalid display name or password.');
    await expect(page.locator('#app')).toBeHidden();
    await page.getByLabel('Password', { exact: true }).fill('browser-test-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#me')).toHaveText('LoginRecovery');
    await expect(page.locator('#connection')).toHaveText('Connected');
    await expect(page.locator('#checkin-error')).toBeEmpty();
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('session restore explains an empty successful response', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  try {
    await page.route('**/api/me', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: '',
    }));
    await page.goto('/');
    await expect(page.locator('#app-error')).toContainText('The server sent an empty response.');
    await expect(page.locator('#checkin')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
  } finally { await context.close(); }
});

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
    await expect(a.locator('#visibility-toggle')).toHaveCount(0);
    await a.getByRole('button', { name: 'Start a quest · 10 min' }).click();
    await b.getByRole('button', { name: 'Start a quest · 10 min' }).click();
    for (const page of [a, b]) {
      await expect(page.locator('#own-quests')).toContainText('Capture en passant');
      await expect(page.locator('#analysis-panel')).toBeHidden();
      await expect(page.locator('#review-controls')).toBeHidden();
      await expect(page.locator('#board img')).toHaveCount(32);
    }
    await a.locator('#guess-picker').selectOption('M08');
    await a.getByRole('button', { name: "Guess opponent's quest", exact: true }).click();
    await expect(a.locator('#guesses')).toContainText('Correct!');
    await b.locator('#guess-picker').selectOption('M08');
    await b.getByRole('button', { name: "Guess opponent's quest", exact: true }).click();
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
    await expect(a.locator('#recap')).toContainText('Adventure complete!');
    await expect(a.locator('#recap .reward-summary')).toContainText('+25 XP');
    await expect(a.locator('#recap .reward-summary')).toContainText('-16 points');
    await expect(a.locator('#profile-stats')).toContainText('1234 (provisional 1/5)');
    await expect(b.locator('#recap .reward-summary')).toContainText('+20 XP');
    await expect(b.locator('#recap .reward-summary')).toContainText('+16 points');
    await a.locator('.recap-details > summary').click();
    await expect(a.locator('.recap-guesses').first()).toHaveText('Guesses: Capture en passant — correct');
    await expect(a.locator('.recap-guesses').first()).not.toContainText(/\d{4}-\d{2}-\d{2}T/);
    await a.locator('.recap-details > summary').click();
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
    await a.locator('#engine-toggle').focus();
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
    await expect(a.locator('#recap .reward-summary')).toContainText('+25 XP');
    const otherTab = await first.newPage();
    otherTab.on('pageerror', (error) => errors.push(error.message));
    await otherTab.goto('/');
    await expect(otherTab.locator('#connection')).toHaveText('Connected');
    await otherTab.locator('#history button').click();
    await a.locator('#engine-toggle').check();
    await otherTab.locator('#engine-toggle').check();
    await a.getByRole('button', { name: 'Back to lobby', exact: true }).click();
    await b.getByRole('button', { name: 'Back to lobby', exact: true }).click();
    await a.getByRole('button', { name: 'Start a quest · 10 min' }).click();
    await b.getByRole('button', { name: 'Start a quest · 10 min' }).click();
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
    await expect(page.locator('#board')).toBeHidden();
    await expect(page.locator('#quest-panel')).toBeHidden();
    for (const selector of ['#find-match-btn', '#challenge-name', '#online-players h2']) {
      await expect(page.locator(selector)).toBeInViewport({ ratio: 1 });
    }
    await page.locator('#history-panel').evaluate((panel) => panel.scrollIntoView({ block: 'center' }));
    await expect(page.locator('#history-panel')).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('#checkin')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
  } finally { await context.close(); }
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
  test(`online players appear automatically and update live at ${viewport.width} x ${viewport.height}`, async ({ browser, baseURL }) => {
    const first = await browser.newContext({ baseURL, viewport });
    const second = await browser.newContext({ baseURL, viewport });
    const a = await first.newPage();
    const b = await second.newPage();
    try {
      await register(a, `DirectoryA${viewport.width}`, '');
      await expect(a.locator('#online-count')).toHaveText('1');
      await expect(a.locator('#players')).toContainText(`DirectoryA${viewport.width}`);
      await register(b, `DirectoryB${viewport.width}`, '');
      await expect(a.locator('#online-players h2')).toBeInViewport({ ratio: 1 });
      await expect(a.locator('#players')).toContainText(`DirectoryB${viewport.width}`);
      await expect(a.locator('#players')).toContainText('available');
      await expect(a.locator('#online-count')).toHaveText('2');
      await expect(b.locator('#online-count')).toHaveText('2');
      await expect(b.locator('#players')).toContainText(`DirectoryA${viewport.width}`);
      await expect(a.locator('#players-empty')).toBeHidden();
      await a.reload();
      await expect(a.locator('#players')).toContainText(`DirectoryB${viewport.width}`);
      const anotherTab = await first.newPage();
      await anotherTab.goto('/');
      await expect(anotherTab.locator('#connection')).toHaveText('Connected');
      await expect(a.locator('#online-count')).toHaveText('2');
      await anotherTab.close();
      await b.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(a.locator('#online-count')).toHaveText('1');
      await expect(a.locator('#players li')).toHaveCount(1);
      await expect(a.locator('#players')).not.toContainText(`DirectoryB${viewport.width}`);
      await b.getByLabel('Username', { exact: true }).fill(`DirectoryB${viewport.width}`);
      await b.getByLabel('Password', { exact: true }).fill('browser-test-password');
      await b.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(b.locator('#connection')).toHaveText('Connected');
      await expect(a.locator('#online-count')).toHaveText('2');
      await expect(b.locator('#online-count')).toHaveText('2');
    } finally { await first.close(); await second.close(); }
  });

  test(`questoc branding and quest-first lobby at ${viewport.width} x ${viewport.height}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport });
    const page = await context.newPage();
    try {
      await page.goto('/');
      await expect(page).toHaveTitle('questoc | Little Chess, Big Adventures');
      await expect(page.locator('.brand p')).toHaveText('Little Chess, Big Adventures');
      await expect(page.getByRole('heading', { name: 'questoc', exact: true })).toBeVisible();
      await expect(page.getByRole('img', { name: 'Chess knight with a golden star' })).toBeVisible();
      await expect(page.getByLabel('How to play')).toContainText('Earn XP');
      const favicon = await page.request.get('/favicon.svg');
      expect(favicon.ok()).toBe(true);
      expect(favicon.headers()['content-type']).toContain('image/svg+xml');
      expect(await favicon.text()).toContain('questoc chess knight');
      await register(page, `Questoc${viewport.width}`, '');
      await expect(page.locator('#profile-stats')).toContainText('0 XP');
      await expect(page.locator('#profile-stats')).toContainText('Quest Rank');
      await expect(page.locator('#profile-stats')).toContainText('Level 1');
      for (const selector of ['#profile-stats', '#find-match-btn', '#challenge-name']) {
        await expect(page.locator(selector)).toBeInViewport({ ratio: 1 });
      }
      await expect(page.locator('#board')).toBeHidden();
      await expect(page.locator('#quest-panel')).toBeHidden();
      await expect(page.locator('#visibility-toggle')).toHaveCount(0);
      await page.locator('.profile-settings summary').click();
      await expect(page.locator('.profile-settings')).toContainText('Your display name appears in the online list');
      await page.locator('.profile-settings summary').click();
      await page.locator('#find-match-btn').click();
      await expect(page.locator('#find-match-btn')).toHaveText('Finding your quest buddy...');
      await expect(page.locator('#find-match-btn')).toBeDisabled();
      await expect(page.locator('#lobby-status')).toContainText('similar chess ratings');
      await expect(page.locator('#board')).toBeHidden();
      await page.getByRole('button', { name: 'Stop searching', exact: true }).click();
      await expect(page.locator('#find-match-btn')).toHaveText('Start a quest · 10 min');
      await expect(page.locator('#find-match-btn')).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally { await context.close(); }
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
  test(`focused play and lobby transitions at ${viewport.width} x ${viewport.height}`, async ({ browser, baseURL }) => {
    const first = await browser.newContext({ baseURL, viewport });
    const second = await browser.newContext({ baseURL, viewport });
    const a = await first.newPage();
    const b = await second.newPage();
    const errors = [];
    for (const page of [a, b]) page.on('pageerror', (error) => errors.push(error.message));
    const mobile = viewport.width <= 1050;
    const assertPlayLayout = async (page) => {
      await expect(page.locator('#board img')).toHaveCount(32);
      for (const selector of ['#board', '#top-player', '#bottom-player', '#own-quests', '#guess-btn']) {
        await expect(page.locator(selector)).toBeInViewport({ ratio: 1 });
      }
      await expect(page.locator('#lobby-panel')).toBeHidden();
      await expect(page.locator('#moves-panel')).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const board = await page.locator('#board').boundingBox();
      expect(board.width).toBeGreaterThan(300);
      expect(Math.abs(board.width - board.height)).toBeLessThan(5);
    };
    try {
      await register(a, `LayoutA${viewport.width}`, '');
      await register(b, `LayoutB${viewport.width}`, '');
      await a.locator('#challenge-name').fill(`LayoutB${viewport.width}`);
      await a.getByRole('button', { name: 'Send challenge', exact: true }).click();
      await expect(b.locator('#challenges')).toContainText(`LayoutA${viewport.width}`);
      await b.getByRole('button', { name: 'Accept', exact: true }).click();
      await assertPlayLayout(a);
      await assertPlayLayout(b);
      if (mobile) {
        for (const size of [{ width: 360, height: 800 }, { width: 844, height: 390 }]) {
          await a.setViewportSize(size);
          for (const selector of ['#board', '#top-player', '#bottom-player', '#own-quests', '#guess-btn']) {
            await expect(a.locator(selector)).toBeInViewport({ ratio: 1 });
          }
          expect(await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        }
        await a.setViewportSize(viewport);
      }
      await a.reload();
      await expect(a.locator('#connection')).toHaveText('Connected');
      await assertPlayLayout(a);
      await a.locator('#board [data-square="e2"]').click();
      await a.locator('#board [data-square="e4"]').click();
      await expect(a.locator('#moves')).toContainText('e4');
      await b.locator('#board [data-square="e7"]').click();
      await b.locator('#board [data-square="e5"]').click();
      await expect(a.locator('#moves')).toContainText('e5');
      await a.locator('#guess-picker').selectOption('M08');
      await a.getByRole('button', { name: "Guess opponent's quest", exact: true }).click();
      await expect(a.locator('#guesses')).toContainText('Correct!');
      await expect(a.locator('#guesses')).toBeInViewport({ ratio: 1 });
      await expect(a.locator('#own-quests')).toBeInViewport({ ratio: 1 });
      if (mobile) await a.locator('#game-tools summary').click();
      a.once('dialog', (dialog) => dialog.accept());
      await a.getByRole('button', { name: 'Resign', exact: true }).click();
      await expect(a.locator('#recap')).toContainText('Adventure complete!');
      await expect(a.locator('#lobby-panel')).toBeHidden();
      await expect(a.locator('#history button')).toHaveCount(1);
      await expect(a.locator('#board')).toBeVisible();
      await expect(a.locator('#recap .reward-summary')).toContainText('+0 XP');
      await expect(a.locator('#recap .reward-summary')).toContainText('-16 points');
      for (const selector of ['#board', '#recap .reward-summary']) {
        await expect(a.locator(selector)).toBeInViewport({ ratio: 1 });
      }
      const finalBoard = await a.locator('#board').boundingBox();
      const rewards = await a.locator('#recap .reward-summary').boundingBox();
      if (mobile) expect(rewards.y).toBeGreaterThan(finalBoard.y + finalBoard.height);
      else expect(rewards.x).toBeGreaterThan(finalBoard.x + finalBoard.width);
      await a.locator('#engine-toggle').check();
      await expect(a.locator('#review-controls')).toBeVisible();
      await a.getByRole('button', { name: 'First position', exact: true }).click();
      await expect(a.locator('#review-position')).toContainText('Position 0 of 2');
      await a.getByRole('button', { name: 'Back to lobby', exact: true }).click();
      await expect(a.locator('#engine-toggle')).not.toBeChecked();
      await expect(a.locator('#board')).toBeHidden();
      await a.locator('#history button').click();
      await expect(a.locator('#board')).toBeVisible();
      await a.getByRole('button', { name: 'Back to lobby', exact: true }).click();
      await a.locator('#find-match-btn').click();
      await expect(a.locator('#board')).toBeHidden();
      await b.getByRole('button', { name: 'Back to lobby', exact: true }).click();
      await b.locator('#find-match-btn').click();
      await assertPlayLayout(a);
      expect(errors).toEqual([]);
    } finally { await first.close(); await second.close(); }
  });
}
