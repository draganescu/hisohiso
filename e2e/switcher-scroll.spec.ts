// Regression for #216: selecting a room from the in-room switcher must land on
// the newest message, matching entry from /rooms. The bug only showed up on
// hash-only switches inside RoomController; /rooms did a fresh route entry and
// scrolled correctly.
import { test, expect, type Page } from '@playwright/test';

const NONCE = () => Math.random().toString(36).slice(2, 10);

async function readSecret(page: Page): Promise<string> {
  await page.waitForURL(/\/room#.+/, { timeout: 30_000 });
  const url = page.url();
  return url.slice(url.indexOf('/room#') + '/room#'.length);
}

async function composeAndSend(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'compose', exact: true }).click();
  const textarea = page.getByRole('textbox', { name: 'new message' });
  await expect(textarea).toBeVisible();
  await textarea.fill(text);
  const cards = page.locator('[data-testid="message-card"]');
  const before = await cards.count();
  const card = cards.filter({ hasText: text });
  // On a freshly-created room the compose button can appear a tick before the
  // message crypto key has landed; submitComposer then no-ops. Retry the same
  // filled draft until the optimistic bubble appears.
  for (let i = 0; i < 10; i += 1) {
    if (await card.isVisible().catch(() => false)) return;
    if (await cards.count().then((count) => count > before).catch(() => false)) return;
    const done = page.getByRole('button', { name: 'done', exact: true });
    if (!(await done.isVisible().catch(() => false))) break;
    await done.click();
    await page.waitForTimeout(250);
  }
  await expect.poll(async () => cards.count(), { timeout: 20_000 }).toBeGreaterThan(before);
}

async function openRoomWithHistory(page: Page, label: string): Promise<{ secret: string; first: string; last: string }> {
  await page.goto('/new');
  const secret = await readSecret(page);
  await expect(page.getByRole('button', { name: 'compose', exact: true })).toBeVisible();

  const first = `${label}-first-${NONCE()}`;
  const last = `${label}-last-${NONCE()}`;
  await composeAndSend(page, first);
  for (let i = 0; i < 18; i += 1) {
    await composeAndSend(page, `${label}-filler-${i}-${NONCE()}`);
  }
  await composeAndSend(page, last);
  return { secret, first, last };
}

async function expectAtNewest(page: Page, newestText: string): Promise<void> {
  await expect.poll(async () => page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollHeight - (window.innerHeight + window.scrollY);
  }), { timeout: 5_000 }).toBeLessThan(80);
  await expect(page.locator('[data-testid="message-card"]').filter({ hasText: newestText })).toBeInViewport();
}

test('switcher room selection opens at newest message like /rooms entry', async ({ page }) => {
  test.setTimeout(180_000);

  const a = await openRoomWithHistory(page, 'switch-a');
  const b = await openRoomWithHistory(page, 'switch-b');

  // Route entry from /rooms is the known-good baseline: it lands at the latest
  // message in room A.
  await page.goto('/rooms');
  await page.locator(`a[href="/room#${a.secret}"]`).click();
  await expectAtNewest(page, a.last);

  // Scroll up to prove the subsequent switch cannot inherit the current room's
  // viewport/window position and still pass by accident.
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await expect(page.locator('[data-testid="message-card"]').filter({ hasText: a.first })).toBeInViewport();

  // Open the top-left switcher and select room B. This is a hash-only switch in
  // RoomController; it used to hydrate B's history while preserving A's top-ish
  // viewport, leaving B at its oldest message.
  await page.getByRole('button', { name: /switch channels/i }).click();
  await page.locator(`a[href="/room#${b.secret}"]`).click();
  await expectAtNewest(page, b.last);
});
