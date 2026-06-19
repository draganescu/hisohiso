// Regression: on desktop viewports, switching channels from the left-hand
// rooms rail while the composer is open and holding a draft must NOT submit
// that draft. The composer's textarea onBlur had an "iOS Done = send" branch
// that fired on ANY blur; on desktop a rail click blurs the textarea, so the
// open draft was sent before the room switched. The fix gates that branch to
// touch devices (pointer: coarse) — desktop sends only via the Done button or
// ⌘/Ctrl↵, never on blur.
import { test, expect, type Page } from '@playwright/test';

const NONCE = () => Math.random().toString(36).slice(2, 10);

async function createRoom(page: Page): Promise<string> {
  await page.goto('/new');
  await page.waitForURL(/\/room#.+/, { timeout: 30_000 });
  const url = page.url();
  await expect(page.getByRole('button', { name: 'compose', exact: true })).toBeVisible();
  return url.slice(url.indexOf('/room#') + '/room#'.length);
}

// Open the composer and send one message, mirroring switcher-scroll.spec's
// helper: a fresh room's compose button can appear a tick before the crypto key
// lands, so retry the filled draft until the optimistic bubble shows.
async function composeAndSend(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'compose', exact: true }).click();
  const textarea = page.getByRole('textbox', { name: 'new message' });
  await expect(textarea).toBeVisible();
  await textarea.fill(text);
  const cards = page.locator('[data-testid="message-card"]');
  const before = await cards.count();
  for (let i = 0; i < 10; i += 1) {
    if (await cards.filter({ hasText: text }).isVisible().catch(() => false)) return;
    const done = page.getByRole('button', { name: 'done', exact: true });
    if (!(await done.isVisible().catch(() => false))) break;
    await done.click();
    await page.waitForTimeout(250);
  }
  await expect.poll(async () => cards.count(), { timeout: 20_000 }).toBeGreaterThan(before);
}

test('rail channel switch does not submit the open compose draft (desktop)', async ({ page }) => {
  test.setTimeout(120_000);

  // Two local rooms so the desktop rail has another channel to hop to. We land
  // in room A after the second creation.
  const b = await createRoom(page);
  const a = await createRoom(page);

  // Open the composer in room A and type a draft — crucially, do NOT submit it.
  await page.getByRole('button', { name: 'compose', exact: true }).click();
  const textarea = page.getByRole('textbox', { name: 'new message' });
  await expect(textarea).toBeVisible();
  const draft = `rail-switch-must-not-send-${NONCE()}`;
  await textarea.fill(draft);

  // Click room B in the persistent left rail. This blurs the textarea. The bug
  // sent `draft` to room A here before navigating away.
  await page.locator(`aside[aria-label="your rooms"] a[href="/room#${b}"]`).first().click();

  // Re-enter room A from a clean route entry and post a sentinel. Waiting for
  // the sentinel to render guarantees any erroneously-sent draft would also have
  // rendered by now, so the absence assertion below can't false-pass on a race.
  await page.goto(`/room#${a}`);
  await expect(page.getByRole('button', { name: 'compose', exact: true })).toBeVisible();
  const sentinel = `sentinel-${NONCE()}`;
  await composeAndSend(page, sentinel);

  await expect(
    page.locator('[data-testid="message-card"]').filter({ hasText: draft })
  ).toHaveCount(0);
});
