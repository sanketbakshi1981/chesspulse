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

async function acknowledgeQuest(page) {
  const dialog = page.getByRole('dialog', { name: 'Your Quest for this game', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Capture en passant');
  await expect(dialog).toContainText('40 base XP');
  await expect(dialog).toContainText('clock is already running');
  await expect(dialog.getByRole('button', { name: 'Got it', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Got it', exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function dismissOutcome(page, title, xp, rating) {
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#outcome-xp')).toHaveText(xp);
  await expect(dialog.locator('#outcome-rating')).toContainText(rating);
  const sizes = await dialog.evaluate((node) => ({
    xp: parseFloat(getComputedStyle(node.querySelector('#outcome-xp')).fontSize),
    rating: parseFloat(getComputedStyle(node.querySelector('#outcome-rating')).fontSize),
  }));
  expect(sizes.xp).toBeGreaterThan(sizes.rating * 2);
  await expect(dialog).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'View game recap', exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function assertBoardCoordinates(page) {
  const coordinates = await page.locator('#board .notation-322f9').evaluateAll((nodes) => nodes.map((node) => {
    const style = getComputedStyle(node);
    const label = node.getBoundingClientRect();
    const square = node.closest('[data-square]').getBoundingClientRect();
    return {
      fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight),
      pointerEvents: style.pointerEvents, width: label.width, height: label.height,
      squareSize: square.width,
      cornerInset: node.classList.contains('numeric-fc462') ? label.right - square.left : square.right - label.left,
    };
  }));
  expect(coordinates).toHaveLength(16);
  for (const coordinate of coordinates) {
    expect(coordinate.fontSize).toBeGreaterThanOrEqual(6);
    expect(coordinate.fontSize).toBeLessThanOrEqual(14);
    expect(coordinate.height).toBeLessThanOrEqual(coordinate.squareSize * 0.3);
    expect(coordinate.cornerInset).toBeLessThan(coordinate.squareSize * 0.25);
    expect(coordinate.lineHeight).toBe(coordinate.fontSize);
    expect(coordinate.pointerEvents).toBe('none');
  }
  return coordinates[0].fontSize;
}

async function assertPhoneBoardWidth(page, evaluation = false) {
  await expect.poll(async () => {
    const board = await page.locator('#board').boundingBox();
    return page.viewportSize().width - board.width;
  }).toBeLessThanOrEqual(evaluation ? 28 : 8);
  const board = await page.locator('#board').boundingBox();
  expect(board.x).toBeLessThanOrEqual(evaluation ? 24 : 4);
  expect(Math.abs(board.width - board.height)).toBeLessThan(5);
}

test('name-only guest entry automatically matches, restores play and shows unrated results', async ({ browser, baseURL }) => {
  const guestContext = await browser.newContext({ baseURL });
  const accountContext = await browser.newContext({ baseURL });
  const guest = await guestContext.newPage();
  const account = await accountContext.newPage();
  try {
    await register(account, 'GuestOpponent', '2800');
    await guest.goto('/');
    await expect(guest.locator('#guest-form input')).toHaveCount(1);
    await guest.getByLabel('Guest nickname', { exact: true }).fill('BrowserGuest');
    await guest.getByRole('button', { name: 'Play as guest', exact: true }).click();
    await expect(guest.locator('#me')).toHaveText('BrowserGuest');
    await expect(guest.locator('#guest-notice')).toBeVisible();
    await expect(guest.locator('#profile-stats')).toContainText('Unrated');
    await expect(guest.locator('#cancel-queue-btn')).toBeVisible();
    await expect(guest.locator('#lobby-status')).toContainText('unrated');
    await expect(guest.locator('#registered-count')).toHaveText(await account.locator('#registered-count').textContent());
    await guest.getByRole('button', { name: 'Stop searching', exact: true }).click();
    await expect(guest.locator('#cancel-queue-btn')).toBeHidden();
    await guest.locator('#find-match-btn').click();
    await account.locator('#find-match-btn').click();
    await acknowledgeQuest(guest);
    await acknowledgeQuest(account);
    await expect(guest.locator('#board-heading')).toContainText('Unrated');
    await expect(account.locator('#board-heading')).toContainText('Unrated');
    await guest.reload();
    await expect(guest.locator('#me')).toHaveText('BrowserGuest');
    await acknowledgeQuest(guest);
    await expect(guest.locator('#board-heading')).toContainText('Unrated');
    if (!await account.locator('#resign-btn').isVisible()) await account.locator('#game-tools summary').click();
    account.once('dialog', (dialog) => dialog.accept());
    await account.getByRole('button', { name: 'Resign', exact: true }).click();
    const outcome = guest.getByRole('dialog', { name: 'You win!', exact: true });
    await expect(outcome).toBeVisible();
    await expect(outcome.locator('#outcome-rating')).toHaveText('Unrated game · Chess ratings unchanged');
    await outcome.getByRole('button', { name: 'View game recap', exact: true }).click();
    await expect(guest.locator('#recap')).toContainText('Unrated');
    const accountOutcome = account.getByRole('dialog', { name: 'You lose', exact: true });
    await expect(accountOutcome.locator('#outcome-rating')).toContainText('Chess ratings unchanged');
    await expect(account.locator('#profile-stats')).toContainText('2800 (provisional 0/5)');
  } finally {
    await guestContext.close();
    await accountContext.close();
  }
});

test('brand logo and wordmark return signed-out visitors to the home page', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  try {
    for (const selector of ['#home-link img', '#home-link h1', '#home-link']) {
      await page.goto('/?view=signup');
      await page.getByRole('button', { name: 'New here? Create an account' }).click();
      await expect(page.locator('#auth-title')).toHaveText('Begin your quest');
      await expect(page.getByRole('link', { name: 'Questoc home', exact: true })).toHaveAttribute('href', '/');
      if (selector === '#home-link') {
        await page.locator(selector).focus();
        await page.keyboard.press('Enter');
      } else {
        await page.locator(selector).click();
      }
      await expect(page).toHaveURL(`${baseURL}/`);
      await expect(page.locator('#auth-title')).toHaveText('Welcome back');
      await expect(page.locator('#checkin')).toBeVisible();
      await expect(page.locator('#app')).toBeHidden();
    }
  } finally { await context.close(); }
});

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
    await expect(page.locator('noscript p')).toHaveText('Please enable JavaScript to sign in and play Questoc.');
    await expect(page.locator('#checkin-form')).toHaveAttribute('method', 'post');
    await page.goto('/?view=home');
    await page.getByRole('link', { name: 'Questoc home', exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/`);
    await expect(page.locator('#checkin')).toBeVisible();
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

test('lobby shows the registered player total below the online list in smaller italics and retains offline accounts', async ({ browser, baseURL }) => {
  const first = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const second = await browser.newContext({ baseURL });
  const a = await first.newPage();
  const b = await second.newPage();
  try {
    await register(a, 'CountBrowserAlice', '');
    const initial = await a.evaluate(async () => (await fetch('/api/me').then((res) => res.json())).registeredPlayers);
    await expect(a.locator('#registered-count')).toHaveText(initial.toLocaleString());
    await register(b, 'CountBrowserBob', '');
    await expect(a.locator('#registered-count')).toHaveText((initial + 1).toLocaleString());
    await expect(b.locator('#registered-count')).toHaveText((initial + 1).toLocaleString());
    await expect(a.locator('#online-count')).toHaveText('2');
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
      await a.setViewportSize(viewport);
      const onlineList = await a.locator('#players').boundingBox();
      const registered = await a.locator('#registered-total').boundingBox();
      expect(registered.y).toBeGreaterThanOrEqual(onlineList.y + onlineList.height);
      await expect(a.locator('#registered-total')).toHaveCSS('font-style', 'italic');
      const sizes = await a.evaluate(() => ({
        total: parseFloat(getComputedStyle(document.getElementById('registered-total')).fontSize),
        heading: parseFloat(getComputedStyle(document.querySelector('#online-players h2')).fontSize),
        player: parseFloat(getComputedStyle(document.querySelector('#players li')).fontSize),
      }));
      expect(sizes.total).toBeLessThan(sizes.heading);
      expect(sizes.total).toBeLessThan(sizes.player);
    }
    await b.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(a.locator('#online-count')).toHaveText('1');
    await expect(a.locator('#registered-count')).toHaveText((initial + 1).toLocaleString());
    await a.reload();
    await expect(a.locator('#registered-count')).toHaveText((initial + 1).toLocaleString());
  } finally { await first.close(); await second.close(); }
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
      await acknowledgeQuest(page);
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
    await acknowledgeQuest(a);
    await expect(a.locator('#own-quests')).toContainText('completed on ply 5');
    await expect(a.locator('#guesses')).toContainText('Correct!');
    a.once('dialog', (dialog) => dialog.accept());
    await a.getByRole('button', { name: 'Resign', exact: true }).click();
    await dismissOutcome(a, 'You lose', '+25 XP', '-16 points');
    await dismissOutcome(b, 'You win!', '+20 XP', '+16 points');
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
    await expect(a.locator('#outcome-dialog')).toBeHidden();
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
    for (const page of [a, b, otherTab]) await acknowledgeQuest(page);
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
    await dismissOutcome(a, 'You lose', '+0 XP', '-15 points');
    await dismissOutcome(b, 'You win!', '+0 XP', '+15 points');
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
    for (const selector of ['#find-match-btn', '#challenge-name']) {
      await expect(page.locator(selector)).toBeInViewport({ ratio: 1 });
    }
    await page.locator('#online-players h2').scrollIntoViewIfNeeded();
    await expect(page.locator('#online-players h2')).toBeInViewport({ ratio: 1 });
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
      await a.locator('#online-players h2').scrollIntoViewIfNeeded();
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

  test(`Questoc branding and quest-first lobby at ${viewport.width} x ${viewport.height}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport });
    const page = await context.newPage();
    try {
      await page.goto('/');
      const introduction = 'Make every chess game a strategic adventure: players still aim to win at chess, but also pursue hidden tactical objectives and try to deduce and block their opponent’s objectives. Chess Quest adds a second layer of mind games without changing the legal rules of chess.';
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => [...document.fonts].some((font) => font.family === 'Montserrat Variable' && font.status === 'loaded'))).toBe(true);
      for (const selector of ['body', '.brand h1', '#auth-submit', '#name-input']) {
        await expect(page.locator(selector)).toHaveCSS('font-family', '"Montserrat Variable", system-ui, sans-serif');
      }
      await expect(page).toHaveTitle('Questoc | A Whole New Way to Play Chess.');
      await expect(page.locator('body')).not.toContainText('Little Chess, Big Adventures');
      await expect(page.locator('#checkin .game-introduction')).toHaveText(introduction);
      await expect(page.locator('#checkin .game-introduction')).toBeVisible();
      await expect(page.locator('.brand-subtitle')).toHaveText('A Whole New Way to Play Chess.');
      await expect(page.locator('.brand-subtitle')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'QUESTOC', exact: true })).toBeVisible();
      await expect(page.locator('.brand h1')).toHaveCSS('font-weight', '900');
      const logo = page.getByRole('img', { name: 'Questoc logo', exact: true });
      await expect(logo).toBeVisible();
      await expect(logo).toHaveAttribute('src', '/img/chesspieces/questoc-logo.png');
      expect(await logo.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
      await expect(page.locator('header')).toHaveCSS('background-color', 'rgb(10, 31, 68)');
      await expect(page.locator('.brand h1')).toHaveCSS('color', 'rgb(204, 153, 51)');
      await expect(page.locator('.brand-subtitle')).toHaveCSS('color', 'rgb(255, 215, 0)');
      await expect(page.locator('#auth-submit')).toHaveCSS('background-color', 'rgb(51, 102, 204)');
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0A1F44');
      await expect(page.getByLabel('How to play')).toContainText('Earn XP');
      await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/img/chesspieces/questoc-logo.png');
      const favicon = await page.request.get('/img/chesspieces/questoc-logo.png');
      expect(favicon.ok()).toBe(true);
      expect(favicon.headers()['content-type']).toContain('image/png');
      await register(page, `Questoc${viewport.width}`, '');
      await expect(page.locator('#lobby .game-introduction')).toHaveText(introduction);
      await expect(page.locator('#lobby .game-introduction')).toBeVisible();
      await expect(page.locator('#lobby h2 + .game-introduction')).toHaveText(introduction);
      await expect(page.locator('#lobby')).not.toContainText('Get a secret quest and earn XP as you play. Every game is a new challenge!');
      await expect(page.locator('#lobby h2').first()).toHaveText('A Whole New Way to Play Chess.');
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
      if (mobile) await assertPhoneBoardWidth(page);
      await assertBoardCoordinates(page);
    };
    try {
      await register(a, `LayoutA${viewport.width}`, '');
      await register(b, `LayoutB${viewport.width}`, '');
      await a.locator('#challenge-name').fill(`LayoutB${viewport.width}`);
      await a.getByRole('button', { name: 'Send challenge', exact: true }).click();
      await expect(b.locator('#challenges')).toContainText(`LayoutA${viewport.width}`);
      await b.getByRole('button', { name: 'Accept', exact: true }).click();
      await acknowledgeQuest(a);
      await acknowledgeQuest(b);
      await assertPlayLayout(a);
      await assertPlayLayout(b);
      for (const selector of ['#home-link img', '#home-link h1']) {
        await a.locator(selector).click();
        await expect(a.locator('#app-error')).toBeEmpty();
        await expect(a.locator('#lobby-panel')).toBeHidden();
        await assertPlayLayout(a);
      }
      if (mobile) {
        let previousCoordinateSize = await assertBoardCoordinates(a);
        for (const size of [{ width: 360, height: 800 }, { width: 844, height: 390 }]) {
          await a.setViewportSize(size);
          for (const selector of ['#board', '#top-player', '#bottom-player', '#own-quests', '#guess-btn']) {
            await expect(a.locator(selector)).toBeInViewport({ ratio: 1 });
          }
          expect(await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          if (size.width < 600) await assertPhoneBoardWidth(a);
          const coordinateSize = await assertBoardCoordinates(a);
          expect(coordinateSize).toBeLessThan(previousCoordinateSize);
          previousCoordinateSize = coordinateSize;
        }
        await a.setViewportSize(viewport);
      }
      await a.reload();
      await expect(a.locator('#connection')).toHaveText('Connected');
      await acknowledgeQuest(a);
      await assertPlayLayout(a);
      await a.locator('#guess-picker').selectOption('E01');
      await a.getByRole('button', { name: "Guess opponent's quest", exact: true }).click();
      await expect(a.locator('#guess-error')).toHaveText('Guess incorrect or no longer eligible. Attempt used.');
      await expect(a.locator('#app-error')).toBeEmpty();
      await expect(a.locator('#guess-count')).toContainText('1 of 2 guesses remaining');
      const guessButton = await a.locator('#guess-btn').boundingBox();
      const guessError = await a.locator('#guess-error').boundingBox();
      expect(guessError.y).toBeGreaterThanOrEqual(guessButton.y + guessButton.height);
      await expect(a.locator('#guess-error')).toBeInViewport({ ratio: 1 });
      const failedGuessAt = (await (await a.request.get('/api/me')).json()).game.guesses[0].submittedAt;
      await a.locator('#board [data-square="e2"]').click();
      await a.locator('#board [data-square="e4"]').click();
      await expect(a.locator('#moves')).toContainText('e4');
      await b.locator('#board [data-square="e7"]').click();
      await b.locator('#board [data-square="e5"]').click();
      await expect(a.locator('#moves')).toContainText('e5');
      await expect(a.locator('#quest-dialog')).toBeHidden();
      await expect.poll(() => Date.now() - failedGuessAt).toBeGreaterThanOrEqual(1000);
      await a.locator('#guess-picker').selectOption('M08');
      await a.getByRole('button', { name: "Guess opponent's quest", exact: true }).click();
      await expect(a.locator('#guesses')).toContainText('Correct!');
      await expect(a.locator('#guess-error')).toBeEmpty();
      await a.locator('#guesses').scrollIntoViewIfNeeded();
      await expect(a.locator('#guesses')).toBeInViewport({ ratio: 1 });
      await expect(a.locator('#own-quests')).toBeInViewport({ ratio: 1 });
      if (mobile) await a.locator('#game-tools summary').click();
      a.once('dialog', (dialog) => dialog.accept());
      await a.getByRole('button', { name: 'Resign', exact: true }).click();
      await dismissOutcome(a, 'You lose', '+0 XP', '-16 points');
      await dismissOutcome(b, 'You win!', '+0 XP', '+16 points');
      await expect(a.locator('#recap')).toContainText('Adventure complete!');
      await expect(a.locator('#lobby-panel')).toBeHidden();
      await expect(a.locator('#history button')).toHaveCount(1);
      await expect(a.locator('#board')).toBeVisible();
      if (mobile) await assertPhoneBoardWidth(a);
      await assertBoardCoordinates(a);
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
      if (mobile) await assertPhoneBoardWidth(a, true);
      await a.getByRole('button', { name: 'First position', exact: true }).click();
      await expect(a.locator('#review-position')).toContainText('Position 0 of 2');
      await a.locator('#home-link img').click();
      await expect(a.locator('#engine-toggle')).not.toBeChecked();
      await expect(a.locator('#board')).toBeHidden();
      await expect(a.locator('#lobby-panel')).toBeVisible();
      await expect(a.locator('#me')).toHaveText(`LayoutA${viewport.width}`);
      await expect(a.locator('#connection')).toHaveText('Connected');
      await a.locator('#history button').click();
      await expect(a.locator('#board')).toBeVisible();
      await a.locator('#home-link h1').click();
      await expect(a.locator('#lobby-panel')).toBeVisible();
      await expect(a.locator('#board')).toBeHidden();
      await a.locator('#find-match-btn').click();
      await expect(a.locator('#board')).toBeHidden();
      await b.getByRole('button', { name: 'Back to lobby', exact: true }).click();
      await b.locator('#find-match-btn').click();
      await expect(a.locator('#quest-dialog')).toBeVisible();
      await expect(a.locator('#move-form button')).toBeDisabled();
      await expect(a.locator('#clock-w')).not.toHaveText('10:00');
      await a.locator('#board [data-square="e2"]').evaluate((square) => square.click());
      await expect(a.locator('#board .selected')).toHaveCount(0);
      await acknowledgeQuest(a);
      await expect(a.locator('#guess-error')).toBeEmpty();
      await assertPlayLayout(a);
      await expect(b.locator('#quest-dialog')).toBeVisible();
      await keyboardMove(a, 'e2e4');
      await expect(b.locator('#moves')).toContainText('e4');
      await expect(b.locator('#quest-dialog')).toBeVisible();
      a.once('dialog', (dialog) => dialog.accept());
      await a.getByRole('button', { name: 'Resign', exact: true }).click();
      await expect(b.locator('#quest-dialog')).toBeHidden();
      await dismissOutcome(a, 'You lose', '+0 XP', '-15 points');
      await dismissOutcome(b, 'You win!', '+0 XP', '+15 points');
      for (const page of [a, b]) await page.getByRole('button', { name: 'Back to lobby', exact: true }).click();
      await a.locator('#find-match-btn').click();
      await b.locator('#find-match-btn').click();
      await acknowledgeQuest(a);
      await acknowledgeQuest(b);
      if (!await a.locator('#draw-btn').isVisible()) await a.locator('#game-tools summary').click();
      await a.getByRole('button', { name: 'Offer draw', exact: true }).click();
      if (!await b.locator('#accept-draw-btn').isVisible()) await b.locator('#game-tools summary').click();
      await b.getByRole('button', { name: 'Accept draw', exact: true }).click();
      await dismissOutcome(a, 'Game drawn!', '+0 XP', '+3 points');
      await dismissOutcome(b, 'Game drawn!', '+0 XP', '-3 points');
      expect(errors).toEqual([]);
    } finally { await first.close(); await second.close(); }
  });
}
