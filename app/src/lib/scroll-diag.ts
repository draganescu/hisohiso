// On-device scroll diagnostics for the agent/control switcher-scroll bug (#224).
//
// That bug — switching INTO an agent/control room via the header switcher lands
// on the OLDEST message — reproduces ONLY in the installed iOS PWA (WKWebView).
// Headless Chromium lands correctly (see e2e/agent-switcher-scroll.spec.ts), so
// the only way to capture ground truth is on the device itself. This tool lets
// us do that without a debugger: enable it, switch into a room, read/copy the
// timeline overlay, and we can SEE whether the entry foot-pin scrolls to the
// foot and is then overridden (and by what).
//
// Enable:  open any app URL with ?scrolldiag=1  (persists in localStorage)
// Disable: open any app URL with ?scrolldiag=0
//
// When on, main.tsx installs a window.scrollTo wrapper (so our own programmatic
// scrolls are logged) and RoomController renders <ScrollDiag/>.

const FLAG_KEY = 'hisohiso:scrolldiag';

export const isScrollDiagEnabled = (): boolean => {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has('scrolldiag')) {
      const on = params.get('scrolldiag') !== '0';
      localStorage.setItem(FLAG_KEY, on ? '1' : '0');
      return on;
    }
    return localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
};

type DiagEntry = { t: number; msg: string };
const LOG: DiagEntry[] = [];
const LISTENERS = new Set<() => void>();
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);
let t0 = now();

export const scrollDiagLog = (msg: string): void => {
  LOG.push({ t: Math.round(now() - t0), msg });
  if (LOG.length > 400) LOG.shift();
  LISTENERS.forEach((fn) => fn());
};

// Called on each room entry so the timeline is scoped to one switch.
export const resetScrollDiag = (): void => {
  LOG.length = 0;
  t0 = now();
  LISTENERS.forEach((fn) => fn());
};

export const getScrollDiagLog = (): DiagEntry[] => LOG.slice();

export const subscribeScrollDiag = (fn: () => void): (() => void) => {
  LISTENERS.add(fn);
  return () => {
    LISTENERS.delete(fn);
  };
};

// Wrap window.scrollTo once so every programmatic scroll our code issues is
// logged. Browser/WKWebView-driven scroll (e.g. scroll restoration on a hash
// nav) does NOT go through here — which is exactly the signal we want: if the
// log shows scrollTo(top=<big>) yet the view ends up at the top, the override
// came from outside our code (the platform), not from us.
let installed = false;
export const installScrollDiag = (): void => {
  if (installed || !isScrollDiagEnabled()) return;
  installed = true;
  const orig = window.scrollTo.bind(window);
  window.scrollTo = ((...args: unknown[]) => {
    const opt = args.length === 1 && typeof args[0] === 'object' && args[0] ? (args[0] as ScrollToOptions) : null;
    const top = opt ? opt.top : (args[1] as number | undefined);
    scrollDiagLog(`scrollTo(top=${Math.round(Number(top) || 0)})`);
    return (orig as (...a: unknown[]) => void)(...args);
  }) as typeof window.scrollTo;
};
