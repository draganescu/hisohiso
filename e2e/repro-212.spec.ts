// Repro harness for issue #212 — "Messages from codex don't show".
//
// Same control-room → spawn → agent-room flow as human-to-agent.spec.ts, but
// spawns the streaming `codex` provider (not the buffered bash echo) because the
// bug lives in the streaming path (agent-manager `provider === 'codex'`). After
// sending one prompt it measures the 212 signature precisely:
//   LIVE   — does the reply render in the room WITHOUT leaving it?
//   RELOAD — after a page reload (which re-reads IndexedDB), does it render?
// 212 reproduced  := LIVE=false AND RELOAD=true (received + persisted, but not
//                    painted live). Fixed/absent := LIVE=true.
//
// The test asserts LIVE rendering directly. Reload is still checked afterward so
// failures can distinguish "not received" from the #212 live-paint regression.
import { test, expect, type Page } from '@playwright/test';

const CONTROL_URL = process.env.HISOHISO_CONTROL_URL;
const CONTROL_CODE = process.env.HISOHISO_CONTROL_CODE ?? '';
const KNOCK_MESSAGE = process.env.HISOHISO_KNOCK_MESSAGE;

function secretFromUrl(joinUrl: string): string {
  const idx = joinUrl.indexOf('#');
  if (idx < 0) throw new Error(`HISOHISO_CONTROL_URL has no #secret: ${joinUrl}`);
  return joinUrl.slice(idx + 1).replace(/^\/?/, '');
}

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

async function knockAndEnter(page: Page, code: string, note: string): Promise<void> {
  await expect(page.getByRole('button', { name: 'request to join' })).toBeVisible({ timeout: 30_000 });
  if (code) await page.locator('input[name="room-key"]').fill(code);
  await page.getByPlaceholder('optional note (e.g. who you are)').fill(note);
  const sent = page.getByText('waiting for approval…');
  const preparing = page.getByText('preparing encryption key…');
  const requestBtn = page.getByRole('button', { name: 'request to join' });
  await requestBtn.click();
  // Success = we left the lobby. Either the knock is in flight ("waiting for
  // approval…") OR auto-admit was fast enough to advance us straight past it (the
  // request button is gone). The original helper polled only for the transient
  // "waiting" text, which a near-instant local auto-admit skips → false timeout.
  // Re-tap ONLY while "preparing encryption key…" (k_knock not yet derived); a
  // second successful knock would mint a fresh keypair and break first-device binding.
  await expect
    .poll(async () => {
      if (await sent.isVisible().catch(() => false)) return true;
      if (!(await requestBtn.isVisible().catch(() => false))) return true;
      if (await preparing.isVisible().catch(() => false)) await requestBtn.click().catch(() => {});
      return false;
    }, { timeout: 30_000 })
    .toBe(true);
}

const inboundCards = (page: Page) =>
  page.locator('[data-testid="message-card"][data-message-direction="in"]');

test('issue #212: codex reply renders live (not only after reload)', async ({ browser }) => {
  test.skip(!CONTROL_URL || !KNOCK_MESSAGE, 'requires a paired test daemon (run via test-loop --browser).');
  test.setTimeout(360_000); // real codex API turn + live wait + reload



  const controlSecret = secretFromUrl(CONTROL_URL!);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    // 1. Join the control room.
    await page.goto(`/room#${controlSecret}`);
    await knockAndEnter(page, CONTROL_CODE, KNOCK_MESSAGE!);
    const spawnButton = page.getByRole('button', { name: /spawn/i });
    await expect(spawnButton).toBeVisible({ timeout: 30_000 });

    // 2. Spawn the codex agent (streaming provider) from the launcher.
    await spawnButton.click();
    await revealLatestBlock(page);
    const codexOption = page.getByRole('button', { name: /^codex$/i });
    await expect(codexOption).toBeVisible({ timeout: 30_000 });
    await codexOption.click();
    await page.getByRole('button', { name: /^Send/ }).click();

    // 3. Join the agent room via the daemon's "Join codex →" action.
    await revealLatestBlock(page);
    const joinAction = page.getByRole('button', { name: /^Join\b.*→$/ }).last();
    await expect(joinAction).toBeVisible({ timeout: 30_000 });
    await joinAction.click();
    await knockAndEnter(page, '', KNOCK_MESSAGE!);
    await expect(page.getByRole('button', { name: 'compose', exact: true })).toBeVisible({ timeout: 30_000 });

    const agentRoomUrl = page.url();
    const before = await inboundCards(page).count();

    // 4. Send a contained prompt (text-only; codex shouldn't need tools for it).
    const prompt = 'Respond with only the single word PINGOK. Do not run any commands or tools.';
    await page.getByRole('button', { name: 'compose', exact: true }).click();
    const textarea = page.getByRole('textbox', { name: 'new message' });
    await expect(textarea).toBeVisible();
    await textarea.fill(prompt);
    await page.getByRole('button', { name: 'done', exact: true }).click();

    // 5. LIVE: wait (without leaving the room) for a NEW inbound card. Codex turns
    //    are real API calls, so allow generous time. A soft check — capture the
    //    boolean rather than failing, so we can still test the reload leg.
    let liveRendered = false;
    try {
      await expect.poll(async () => inboundCards(page).count(), { timeout: 120_000, intervals: [1000] })
        .toBeGreaterThan(before);
      liveRendered = true;
    } catch {
      liveRendered = false;
    }
    const liveText = liveRendered ? (await inboundCards(page).last().innerText()).slice(0, 120) : '(none live)';
    console.log(`#212 LIVE_RENDERED=${liveRendered}`);
    console.log(`#212 LIVE_TEXT=${JSON.stringify(liveText)}`);
    expect(liveRendered, '#212 regression: codex reply persisted but did not render live').toBe(true);

    // 6. RELOAD: reload the agent room (re-reads IndexedDB) and assert the reply
    //    is present. This proves the message was received + persisted regardless
    //    of the live result; combined with LIVE=false it confirms #212.
    await page.goto(agentRoomUrl);
    await expect(inboundCards(page).first()).toBeVisible({ timeout: 60_000 });
    const reloadCount = await inboundCards(page).count();
    const reloadText = (await inboundCards(page).last().innerText()).slice(0, 120);
    console.log(`#212 RELOAD_RENDERED=true RELOAD_COUNT=${reloadCount}`);
    console.log(`#212 RELOAD_TEXT=${JSON.stringify(reloadText)}`);
    console.log(`#212 VERDICT=${liveRendered ? 'NOT_REPRODUCED (live ok)' : 'REPRODUCED (live missing, reload ok)'}`);

    expect(reloadCount).toBeGreaterThan(before);
  } finally {
    await ctx.close();
  }
});
