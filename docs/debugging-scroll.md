# Debugging room scroll (and the agent/control switcher-scroll bug)

Hard-won notes for anyone touching message-list scrolling or the room switcher.
Read this before "fixing" a scroll bug — two confident fixes here missed because
the actual failure mode was not what the code reading suggested.

## How room scrolling works

- The message thread is **document-scrolled** — there is no inner scroll
  container. `useMessageWindow` falls back to `window`/`document.documentElement`
  (the list ref is intentionally not attached). So scroll = `window.scrollTo` /
  `window.scrollY` / `document.documentElement.scrollHeight`. See the big comment
  above the message list in `app/src/pages/RoomController.tsx`.
- Classic order: messages render in a `flex-col-reverse` column, so the **newest
  message is at the foot** of the document. "Scroll to newest" = scroll to
  `scrollHeight`.
- **Entry/switch foot-pin** (`#211`, search `initialScrollPendingRef`): on a room
  change we set `initialScrollPendingRef = true` and a `ResizeObserver` re-pins
  the view to the foot every time the document height changes, until either the
  user scrolls up or a ~1.5s backstop timeout releases it.
- `handleScroll` releases the pin early on a deliberate scroll-up. (Hardened in
  `#224` to only release on a *real* user gesture — `userScrolledRef`, set by
  `wheel`/`touchmove` — so an involuntary platform scroll can't disarm it.)

## Two ways to enter a room — they differ

- **`/rooms` route**: each row is an `<a href="/room#<secret>">` (`RoomCard`). A
  tap is a full browser navigation; `RoomController` **unmounts and re-mounts**.
  On that fresh mount it hits the `skipReset` fast-path
  (`RoomController.tsx`, search `skipReset`) and stays in `PARTICIPANT`.
- **Header switcher modal**: each row is a `<button onSelect>` (`RoomRow`, carries
  a `data-room-secret` for e2e) that calls `navigateToRoom()`. That only sets
  `window.location.hash`; the component **stays mounted** and re-runs its init
  effect, doing the **full reset** (`roomState -> 'INIT'`, `messages -> []`,
  `roomContext/agentCount -> null`) and re-deriving the room async.

`#221` was a switcher-only race: the modal's `scroll-locked` class (which makes
`main.tsx` force `scrollTo(0,0)` on viewport events) stayed on for a render while
the new room hydrated, beating the foot-pin. Fixed by closing the switcher
synchronously in the same event as the navigation.

## The agent/control switcher-scroll bug (#224) — READ THIS

Symptom (reported on an **installed iOS PWA / home-screen**): switching INTO an
**agent or control** room via the header switcher lands on the **oldest** message.
Human↔human (chat) rooms are correct both ways; all rooms are correct via `/rooms`.

**Key finding: it does NOT reproduce in headless Chromium.** A full Playwright
repro (`e2e/agent-switcher-scroll.spec.ts`) drives the exact path — spawn a bash
agent, build history, hop to the control room, switch back into the agent room —
and samples scroll geometry. In Chromium the switch lands at `distFromBottom: 0`
and stays there. So the bug is **specific to the iOS WKWebView**, not the app
logic Chromium exercises.

Things that were investigated and are **NOT** the cause (don't re-chase them):

- `history.scrollRestoration` — would break human↔human via the switcher too; it
  doesn't. (We still set it to `'manual'` in `main.tsx` as correct hygiene.)
- Layout shift from agent/control chrome — the context strip is `fixed` and the
  command bar is floating; neither changes document `scrollHeight`.
- The `scrollTo(0,0)` modal-lock path — no modal auto-opens for those rooms on
  entry.

The remaining real difference is the **entry path** (`/rooms` remount + `skipReset`
+ stays `PARTICIPANT`, vs switcher reset to `INIT` + async daemon re-stamp of
`roomKind`/`roomContext`/`agentCount`). The exact mechanism on WKWebView is still
open as of this writing — capture it on-device before fixing.

### On-device diagnostics (how to get ground truth)

Because it's WKWebView-only, debug it on the device, not in the harness:

1. Bring the branch up on a phone-reachable preview (see
   `docs/local-worktree-testing.md` / the `test-worktree` skill).
2. On the iPhone, open the app with `?scrolldiag=1` (persists in localStorage;
   `?scrolldiag=0` turns it off). Implemented in `app/src/lib/scroll-diag.ts` +
   `app/src/components/ScrollDiag.tsx`.
3. A black overlay appears at the bottom of room view. It resets on each room
   entry and shows a timeline: `ENTER kind=… state=…`, sampled
   `y=/h=/dist=/cards=` geometry for ~5s, every `scrollTo(top=…)` our code makes,
   and late `state ->`/`kind ->` transitions.
4. Switch into an agent room, then tap **copy** (or screenshot). The thing to
   look for: does a `scrollTo(top=<big>)` fire and then `y` snap back to ~0
   (platform override), or does the foot-pin never fire for these rooms?

## e2e gotcha: headless Chromium dies on agent rooms

If an agent/control e2e (anything that spawns a daemon agent and renders its
room) fails with **`Target page, context or browser has been closed`** or
**`Channel closed`** with no page-`crash` event and no screenshot/error-context,
the **Chromium process is dying** (OOM / small `/dev/shm`), not your test.

Fix: `launchOptions: { args: ['--disable-dev-shm-usage'] }` in
`e2e/playwright.config.ts` (already set). This is why earlier agent-room specs
(including the `#221` `test.fixme` one) kept crashing mid-run. With it, agent
rooms drive reliably.
