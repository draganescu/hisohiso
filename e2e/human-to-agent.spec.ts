// human↔agent PWA fidelity test.
//
// Drives a single browser through the REAL PWA UI to pair with a
// daemon-spawned agent room and asserts the agent's reply round-trips. The
// orchestrator (scripts/test-loop.mjs --browser) owns the relay AND an isolated
// test daemon (HISOHISO_HOME=~/.hisohiso-test) whose control room is paired
// non-interactively via HISOHISO_KNOCK_MESSAGE. It exports the control-room
// join material so the browser can join headlessly:
//
//   HISOHISO_URL            relay base URL            (playwright.config baseURL)
//   HISOHISO_CONTROL_URL    `${server}/room#<secret>` (control room join link)
//   HISOHISO_CONTROL_CODE   control room pairing code
//   HISOHISO_KNOCK_MESSAGE  session knock message (the auto-admit factor — the
//                           same value the daemon was paired with; the PWA
//                           sends it as the knock NOTE so both the control room
//                           and the spawned agent room auto-admit this browser)
//
// Flow (all through the genuine UI):
//   1. Open the control room link → LOBBY_WAITING → enter code + knock note
//      (= session knock message) → "request to join". Daemon auto-admits
//      (first-device-wins, knock-message match).
//   2. In the control room, tap "spawn" → pick the `bash` agent in the launcher
//      block → daemon spawns and posts a "Join bash" join-room action.
//   3. Tap the "Join bash" action → joinActionRoom sets the agent room password
//      + navigates into it → LOBBY_WAITING for the agent room.
//   4. Enter the same knock note (session knock message) → "request to join".
//      The agent room auto-admits the first authenticated knock.
//   5. Send a deterministic shell line → assert the bash agent's echoed reply
//      renders decrypted as an inbound message.
//
// Selectors used (pre-existing in app/src except the documented add):
//   - Lobby:    input[name="room-key"], textarea[placeholder*="optional note"],
//               button "request to join".
//   - Control:  button "spawn" (ControlCommandBar). Launcher/list are daemon-
//               sent interactive blocks rendered as round buttons whose text is
//               the option label; the bash option + the "Join bash …" action
//               are matched by accessible text. Message DOM is newest-first
//               because the thread uses flex-col-reverse.
//   - Compose:  button "compose" → textarea[aria-label="new message"] →
//               button "done".
//   - Assert:   [data-testid="message-card"][data-message-direction="in"]
//               — DOCUMENTED ADD (shared with human-to-human.spec.ts): a
//               `data-testid="message-card"` + `data-message-direction`
//               attribute on the message button in
//               app/src/pages/RoomController.tsx (~line 2422).
import { test, expect, type Page } from '@playwright/test';

const NONCE = () => Math.random().toString(36).slice(2, 10);

// Daemon-sent interactive blocks (the launcher picker, the "Join …" action)
// render COLLAPSED in the PWA as a "… tap to view" chip — their inner buttons
// aren't in the DOM until the chip is expanded. Tap the newest collapsed chip
// to reveal it; expanding clears its "tap to view" text, so `.last()` always
// targets the freshest unexpanded block.
async function revealLatestBlock(page: Page): Promise<void> {
  // If a previous block detail sheet is still open after a button response,
  // close it before trying to click the next card in the thread.
  const back = page.locator('.room-overlay').getByRole('button', { name: 'back' });
  if (await back.isVisible().catch(() => false)) {
    await back.click({ force: true, timeout: 2_000 }).catch(() => {});
    await expect(back).toBeHidden({ timeout: 5_000 }).catch(() => {});
  }

  // Message DOM is newest-first (rendered inside flex-col-reverse). Target the
  // newest message that actually carries an interactive block; older plain
  // messages can also contain “tap to view” wording in detail/reply previews.
  const chip = page
    .locator('[data-testid="message-card"]')
    .filter({ hasText: /interactive .*blocks? — tap to view/i })
    .first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
}

const CONTROL_URL = process.env.HISOHISO_CONTROL_URL;
const CONTROL_CODE = process.env.HISOHISO_CONTROL_CODE ?? '';
const KNOCK_MESSAGE = process.env.HISOHISO_KNOCK_MESSAGE;

// Pull the room secret out of a `${server}/room#<secret>` join link so we can
// navigate via baseURL-relative path (keeps us on the Playwright baseURL origin
// rather than whatever host the daemon stamped into the link).
function secretFromUrl(joinUrl: string): string {
  const idx = joinUrl.indexOf('#');
  if (idx < 0) throw new Error(`HISOHISO_CONTROL_URL has no #secret: ${joinUrl}`);
  return joinUrl.slice(idx + 1).replace(/^\/?/, '');
}

// Knock into the room currently shown on `page` (must be LOBBY_WAITING): fill
// the pairing code + the note, request to join, and wait until the participant
// view (compose FAB or control command bar) appears — i.e. auto-admit landed.
async function knockAndEnter(page: Page, code: string, note: string): Promise<void> {
  await expect(page.getByRole('button', { name: 'request to join' })).toBeVisible({
    timeout: 30_000,
  });
  if (code) {
    await page.locator('input[name="room-key"]').fill(code);
  }
  await page.getByPlaceholder('optional note (e.g. who you are)').fill(note);
  // sendKnock no-ops with "preparing encryption key…" if k_knock isn't derived
  // yet (RoomController.tsx sendKnock); the derivation lands a tick after the
  // lobby renders. Re-tap ONLY while it's still preparing — a second *successful*
  // knock mints a fresh ephemeral keypair, which would break the daemon's
  // first-device binding (it wraps the token to the first knock's pubkey). So we
  // stop the moment the knock actually goes out ("waiting for approval…").
  const sent = page.getByText('waiting for approval…');
  const preparing = page.getByText('preparing encryption key…');
  const requestBtn = page.getByRole('button', { name: 'request to join' });
  // First tap. If k_knock was ready it sends immediately; otherwise it no-ops
  // into "preparing encryption key…".
  await requestBtn.click();
  await expect
    .poll(async () => {
      if (await sent.isVisible().catch(() => false)) return true;
      // If the request button disappeared, we already advanced out of the lobby
      // (local auto-admit can be faster than the transient waiting text).
      if (!(await requestBtn.isVisible().catch(() => false))) return true;
      // Re-tap ONLY when the UI is showing "preparing" — that state only appears
      // after a no-op tap (k_knock not yet derived), so a re-tap here can't
      // double-send. A second *successful* knock would mint a fresh ephemeral
      // keypair and break the daemon's first-device token binding.
      if (await preparing.isVisible().catch(() => false)) {
        await requestBtn.click().catch(() => {});
      }
      return false;
    }, { timeout: 30_000 })
    .toBe(true);
}

test('a browser pairs a daemon control room, spawns bash, and round-trips a reply', async ({
  browser,
}) => {
  test.skip(
    !CONTROL_URL || !KNOCK_MESSAGE,
    'requires a paired test daemon: HISOHISO_CONTROL_URL + HISOHISO_KNOCK_MESSAGE ' +
      '(exported by scripts/test-loop.mjs --browser).'
  );

  const controlSecret = secretFromUrl(CONTROL_URL!);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    // --- 1. Join the control room (auto-admit on knock-message match) ---
    await page.goto(`/room#${controlSecret}`);
    await knockAndEnter(page, CONTROL_CODE, KNOCK_MESSAGE!);

    // Control rooms swap the compose FAB for the command bar; "spawn" appearing
    // proves we were admitted and the room is recognized as a control room.
    const spawnButton = page.getByRole('button', { name: /spawn/i });
    await expect(spawnButton).toBeVisible({ timeout: 30_000 });

    // --- 2. Spawn the bash agent via the launcher block ---
    await spawnButton.click();
    // The daemon replies with an agent picker (interactive buttons), rendered as
    // a collapsed block — expand it, then pick the `bash` option by its label.
    await revealLatestBlock(page);
    const bashOption = page.getByRole('button', { name: /^bash$/i });
    await expect(bashOption).toBeVisible({ timeout: 30_000 });
    await bashOption.click();
    await page.getByRole('button', { name: /^Send/ }).click();

    // --- 3. Tap the join-room action the daemon posts for the new agent room ---
    // Also a collapsed interactive block; expand it, then tap the "Join …" button
    // (a role="button" span reading "Join <agentName> →").
    await revealLatestBlock(page);
    const joinAction = page.getByRole('button', { name: /^Join\b.*→$/ }).last();
    await expect(joinAction).toBeVisible({ timeout: 30_000 });
    await joinAction.click();

    // joinActionRoom navigates into the agent room (sets its code from the
    // action). We land in the agent room's LOBBY_WAITING.
    // --- 4. Knock into the agent room (auto-admit on knock-message match) ---
    // The action already stored the agent room pairing code, so leave the code
    // field as-is (empty fill is a no-op) and just send the matching note.
    await knockAndEnter(page, '', KNOCK_MESSAGE!);

    // Agent rooms show the compose FAB once admitted.
    await expect(page.getByRole('button', { name: 'compose', exact: true })).toBeVisible({
      timeout: 30_000,
    });

    // --- 5. Send a deterministic shell line and assert the echoed reply ---
    const token = `e2e-${NONCE()}`;
    const command = `echo ${token}`;
    await page.getByRole('button', { name: 'compose', exact: true }).click();
    const textarea = page.getByRole('textbox', { name: 'new message' });
    await expect(textarea).toBeVisible();
    await textarea.fill(command);
    await page.getByRole('button', { name: 'done', exact: true }).click();

    // The bash agent runs the command and posts its stdout back into the room.
    // Assert the unique token appears in a decrypted inbound message bubble.
    await expect(
      page
        .locator('[data-testid="message-card"][data-message-direction="in"]')
        .filter({ hasText: token })
    ).toBeVisible({ timeout: 45_000 });
  } finally {
    await ctx.close();
  }
});
