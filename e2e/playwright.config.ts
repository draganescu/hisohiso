import { defineConfig, devices } from '@playwright/test';

// Playwright config for the hisohiso PWA fidelity layer.
//
// Deliberately has NO `webServer` block: the orchestrator
// (`scripts/test-loop.mjs --browser`) owns the relay lifecycle. The relay is a
// containerized, pre-built static bundle (FrankenPHP serving app/dist), not a
// `vite dev` server Playwright could spawn — so Playwright must NOT try to
// start or own it. It only drives a browser against the already-running relay.
//
// `baseURL` comes from HISOHISO_URL (the loopback relay URL the orchestrator
// derived from the worktree path, e.g. http://localhost:8137). Specs use
// page-relative paths (`/new`, `/room#...`) against it.
const baseURL = process.env.HISOHISO_URL;

if (!baseURL) {
  throw new Error(
    'HISOHISO_URL is not set. The orchestrator (scripts/test-loop.mjs --browser) ' +
      'must export the per-worktree relay URL before invoking Playwright.'
  );
}

export default defineConfig({
  testDir: '.',
  // Round-trips cross the relay + SSE + crypto; give them room but stay bounded
  // so a stuck handshake fails loudly rather than hanging an agent's loop.
  timeout: 60_000,
  expect: { timeout: 20_000 },
  // The human↔agent spec shares a single daemon-spawned agent room, and the
  // human↔human spec opens two contexts in one test; keep runs serial and
  // deterministic rather than racing parallel browsers against one relay.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL,
    headless: true,
    // Local loopback relay serves plain HTTP with no TLS in dev; the PWA's
    // crypto runs in a secure context only on https or localhost, so the relay
    // URL must be localhost-based (it is — derived loopback). Ignore HTTPS
    // errors defensively in case a future prod-shaped relay is pointed at.
    ignoreHTTPSErrors: true,
    actionTimeout: 15_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
