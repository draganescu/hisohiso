// human↔human PWA fidelity test.
//
// Two isolated browser contexts (separate origins of trust — separate
// IndexedDB / localStorage) open the SAME room through the REAL PWA UI and
// round-trip an end-to-end-encrypted message: A creates a room, B knocks, A
// approves via the inline knock card, then A→B and B→A each assert the typed
// plaintext renders decrypted on the other side. No crypto is stubbed — the
// app derives k_msg/k_knock and talks to the orchestrator-owned relay.
//
// The orchestrator (scripts/test-loop.mjs --browser) owns the Docker relay and
// exports its loopback URL as HISOHISO_URL (consumed by playwright.config.ts as
// baseURL). This spec owns no infrastructure.
//
// Selectors used (all pre-existing in app/src except the one documented add):
//   - Create:   navigate to `/new` (RoomCreator auto-mints, redirects to
//               `/room#<secret>`).
//   - Lobby:    input[name="room-key"] (pairing code), textarea[placeholder*=
//               "optional note"] (knock note), button "request to join"
//               (RoomController LOBBY_WAITING).
//   - Approve:  button "let in" (inline knock card).
//   - Compose:  button "compose" → textarea[aria-label="new message"] →
//               button "done" (composer modal).
//   - Assert:   [data-testid="message-card"][data-message-direction="in"|"out"]
//               — DOCUMENTED ADD: a `data-testid="message-card"` +
//               `data-message-direction` attribute was added to the message
//               button in app/src/pages/RoomController.tsx (~line 2422). The
//               `.message-card-in` class is shared by reply-preview chrome and
//               the live-work indicator, so the testid disambiguates a real
//               rendered message bubble for a stable text assertion.
import { test, expect, type Page } from '@playwright/test';

// A fresh token per use so reruns never collide on a stale room row in the
// relay's SQLite, and so each asserted message string is unique on the page.
const NONCE = () => Math.random().toString(36).slice(2, 10);

// RoomCreator mints the room on mount and redirects to `/room#<secret>`. Wait
// for that redirect and return the secret from the URL hash.
async function readShareSecret(page: Page): Promise<string> {
  await page.waitForURL(/\/room#.+/, { timeout: 30_000 });
  const url = page.url();
  return url.slice(url.indexOf('/room#') + '/room#'.length);
}

// Send a message through the real composer modal and wait for the optimistic
// outgoing bubble to render (proves the local encrypt+send path ran).
async function composeAndSend(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'compose', exact: true }).click();
  const textarea = page.getByRole('textbox', { name: 'new message' });
  await expect(textarea).toBeVisible();
  await textarea.fill(text);
  await page.getByRole('button', { name: 'done', exact: true }).click();
  // Own outgoing message renders optimistically as a message-card-out bubble.
  await expect(
    page
      .locator('[data-testid="message-card"][data-message-direction="out"]')
      .filter({ hasText: text })
  ).toBeVisible();
}

// Assert an INBOUND (decrypted) message with the exact text renders on `page`.
async function expectInbound(page: Page, text: string): Promise<void> {
  await expect(
    page
      .locator('[data-testid="message-card"][data-message-direction="in"]')
      .filter({ hasText: text })
  ).toBeVisible();
}

test('two browsers round-trip an end-to-end-encrypted message', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    // --- A creates the room ---
    await pageA.goto('/new');
    const secret = await readShareSecret(pageA);
    expect(secret.length).toBeGreaterThan(10);

    // A must be present (online) to receive B's knock. Landing on the room as
    // the creator/participant establishes presence via the room's SSE
    // subscription. Wait for the participant chrome (the compose FAB).
    await expect(pageA.getByRole('button', { name: 'compose', exact: true })).toBeVisible();

    // --- B opens the same room and knocks (no pairing code: the creator set
    //     no password, so both derive k_knock/k_msg from the empty password) ---
    await pageB.goto(`/room#${secret}`);
    await expect(pageB.getByRole('button', { name: 'request to join' })).toBeVisible();

    // A voluntary note so the knock card on A's side is recognizable. The note
    // is NOT a security factor here (no expected-knock-message set); A approves
    // manually by tapping "let in".
    const knockNote = `e2e-knock-${NONCE()}`;
    await pageB.getByPlaceholder('optional note (e.g. who you are)').fill(knockNote);
    // sendKnock no-ops with "preparing encryption key…" if k_knock hasn't been
    // derived yet (RoomController.tsx sendKnock). The derivation finishes a tick
    // after the lobby renders, so re-tap ONLY while it's still preparing (a tap
    // then is a no-op) until the knock actually goes out ("waiting for approval…").
    const sent = pageB.getByText('waiting for approval…');
    const preparing = pageB.getByText('preparing encryption key…');
    const requestBtn = pageB.getByRole('button', { name: 'request to join' });
    await requestBtn.click();
    await expect
      .poll(async () => {
        if (await sent.isVisible()) return true;
        if (await preparing.isVisible()) {
          await requestBtn.click();
        }
        return sent.isVisible();
      }, { timeout: 30_000 })
      .toBe(true);

    // --- A sees the inline knock card and lets B in ---
    const knockCard = pageA.getByText(knockNote);
    await expect(knockCard).toBeVisible({ timeout: 30_000 });
    await pageA.getByRole('button', { name: 'let in' }).click();

    // B transitions out of the lobby into the participant view (compose FAB).
    await expect(pageB.getByRole('button', { name: 'compose', exact: true })).toBeVisible({
      timeout: 30_000,
    });

    // --- A → B ---
    const fromA = `hello-from-A-${NONCE()}`;
    await composeAndSend(pageA, fromA);
    await expectInbound(pageB, fromA);

    // --- B → A ---
    const fromB = `hello-from-B-${NONCE()}`;
    await composeAndSend(pageB, fromB);
    await expectInbound(pageA, fromB);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
