// Chromium smoke test for the agent-room switcher-scroll path (#224).
//
// IMPORTANT FINDING (see docs/debugging-scroll.md): the user-reported bug —
// switching INTO an agent/control room via the header switcher lands on the
// OLDEST message — reproduces ONLY in the installed iOS PWA (WKWebView). In
// headless Chromium the switch lands correctly at the newest message, as this
// test asserts. So this test does NOT guard the iOS bug; it is a regression
// guard for the Chromium-observable behavior and a worked example of driving an
// agent room through the switcher. The iOS bug is diagnosed on-device via the
// scroll-diag overlay (lib/scroll-diag.ts), not here.
//
// Requires the headless-Chromium /dev/shm fix (--disable-dev-shm-usage in
// playwright.config.ts); without it the browser process dies mid-run on agent
// rooms with "Target page/context/browser has been closed".
import { test, expect, type Page } from '@playwright/test';

const NONCE = () => Math.random().toString(36).slice(2, 10);

const CONTROL_URL = process.env.HISOHISO_CONTROL_URL;
const CONTROL_CODE = process.env.HISOHISO_CONTROL_CODE ?? '';
const KNOCK_MESSAGE = process.env.HISOHISO_KNOCK_MESSAGE;

function secretFromUrl(joinUrl: string): string {
  const idx = joinUrl.indexOf('#');
  if (idx < 0) throw new Error(`HISOHISO_CONTROL_URL has no #secret: ${joinUrl}`);
  return joinUrl.slice(idx + 1).replace(/^\/?/, '');
}

async function readSecret(page: Page): Promise<string> {
  await page.waitForURL(/\/room#.+/, { timeout: 30_000 });
  const url = page.url();
  return url.slice(url.indexOf('/room#') + '/room#'.length);
}

async function knockAndEnter(page: Page, code: string, note: string): Promise<void> {
  await expect(page.getByRole('button', { name: 'request to join' })).toBeVisible({ timeout: 30_000 });
  if (code) await page.locator('input[name="room-key"]').fill(code);
  await page.getByPlaceholder('optional note (e.g. who you are)').fill(note);
  const sent = page.getByText('waiting for approval…');
  const preparing = page.getByText('preparing encryption key…');
  const requestBtn = page.getByRole('button', { name: 'request to join' });
  await requestBtn.click();
  await expect
    .poll(async () => {
      if (await sent.isVisible().catch(() => false)) return true;
      if (!(await requestBtn.isVisible().catch(() => false))) return true;
      if (await preparing.isVisible().catch(() => false)) await requestBtn.click().catch(() => {});
      return false;
    }, { timeout: 30_000 })
    .toBe(true);
}

async function revealLatestBlock(page: Page): Promise<void> {
  const back = page.locator('.room-overlay').getByRole('button', { name: 'back' });
  if (await back.isVisible().catch(() => false)) {
    await back.click({ force: true, timeout: 2_000 }).catch(() => {});
    await expect(back).toBeHidden({ timeout: 5_000 }).catch(() => {});
  }
  const chip = page
    .locator('[data-testid="message-card"]')
    .filter({ hasText: /interactive .*blocks? — tap to view/i })
    .first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
}

async function composeAndSend(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'compose', exact: true }).click();
  const textarea = page.getByRole('textbox', { name: 'new message' });
  await expect(textarea).toBeVisible();
  await textarea.fill(text);
  const cards = page.locator('[data-testid="message-card"]');
  const before = await cards.count();
  for (let i = 0; i < 10; i += 1) {
    if (await cards.count().then((c) => c > before).catch(() => false)) return;
    const done = page.getByRole('button', { name: 'done', exact: true });
    if (!(await done.isVisible().catch(() => false))) break;
    await done.click();
    await page.waitForTimeout(200);
  }
  await expect.poll(async () => cards.count(), { timeout: 20_000 }).toBeGreaterThan(before);
}

// Open the header switcher and select the room with `secret`, then sample the
// scroll geometry for ~2.4s so we can see whether it lands at the foot and
// stays. Returns the sampled timeline.
async function switchAndSample(page: Page, secret: string): Promise<Array<Record<string, number>>> {
  await page.getByRole('button', { name: /switch channels/i }).click();
  const row = page.locator(`.modal-shell [data-room-secret="${secret}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  const samples: Array<Record<string, number>> = [];
  for (let i = 0; i < 12; i += 1) {
    samples.push(
      await page.evaluate(() => ({
        scrollY: Math.round(window.scrollY),
        scrollHeight: Math.round(document.documentElement.scrollHeight),
        innerHeight: Math.round(window.innerHeight),
        distFromBottom: Math.round(
          document.documentElement.scrollHeight - (window.innerHeight + window.scrollY),
        ),
        cards: document.querySelectorAll('[data-testid="message-card"]').length,
      })),
    );
    await page.waitForTimeout(200);
  }
  return samples;
}

test('switching into an agent room via the switcher lands at newest (Chromium)', async ({ browser }) => {
  test.skip(
    !CONTROL_URL || !KNOCK_MESSAGE,
    'requires a paired test daemon (scripts/test-loop.mjs --browser).',
  );
  test.setTimeout(180_000);

  const controlSecret = secretFromUrl(CONTROL_URL!);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    // Join control, spawn bash, join the agent room.
    await page.goto(`/room#${controlSecret}`);
    await knockAndEnter(page, CONTROL_CODE, KNOCK_MESSAGE!);
    await expect(page.getByRole('button', { name: /spawn/i })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /spawn/i }).click();
    await revealLatestBlock(page);
    await expect(page.getByRole('button', { name: /^bash$/i })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /^bash$/i }).click();
    await page.getByRole('button', { name: /^Send/ }).click();
    await revealLatestBlock(page);
    const joinAction = page.getByRole('button', { name: /^Join\b.*→$/ }).last();
    await expect(joinAction).toBeVisible({ timeout: 30_000 });
    await joinAction.click();
    await knockAndEnter(page, '', KNOCK_MESSAGE!);
    await expect(page.getByRole('button', { name: 'compose', exact: true })).toBeVisible({ timeout: 30_000 });
    const agentSecret = await readSecret(page);

    // Small scrollable history (each echo = outbound + bash reply).
    let agentLast = '';
    for (let i = 0; i < 8; i += 1) {
      agentLast = `e2e-${NONCE()}`;
      await composeAndSend(page, `echo ${agentLast}`);
    }
    await expect(
      page.locator('[data-testid="message-card"][data-message-direction="in"]').filter({ hasText: agentLast }),
    ).toBeVisible({ timeout: 45_000 });

    // Hop to the control room so the next switch is a genuine switch INTO the
    // agent room (the reported repro path).
    await switchAndSample(page, controlSecret);

    // Switch INTO the agent room via the switcher and assert it lands at newest.
    const timeline = await switchAndSample(page, agentSecret);
    // eslint-disable-next-line no-console
    console.log('AGENT-SWITCH timeline:', JSON.stringify(timeline));
    const final = timeline[timeline.length - 1];
    expect(
      final.distFromBottom,
      `Expected to land at newest (distFromBottom<=80). Timeline: ${JSON.stringify(timeline)}`,
    ).toBeLessThanOrEqual(80);
  } finally {
    await ctx.close().catch(() => {});
  }
});
