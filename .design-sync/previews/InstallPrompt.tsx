import { InstallPrompt } from 'hisohiso-app';

// InstallPrompt renders its card only when useInstallPrompt() reports
// canInstall = !installed && (deferredPrompt !== null || isIOS). Headless has no
// `beforeinstallprompt`, so force the iOS path:
//   - detectIOS(): true when navigator.userAgent matches /iphone|ipad|ipod/, OR
//     navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1.
//   - detectStandalone(): must stay false (not already installed) — default in
//     a plain headless page (no standalone display-mode, no navigator.standalone).
//   - dismissed reads sessionStorage['hisohiso.install.dismissed'] — clear it.
// Spoof BEFORE the hook runs (module scope) so the first render sees iOS.
if (typeof navigator !== 'undefined') {
  try {
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5, configurable: true });
  } catch {
    /* read-only in some engines — the UA spoof below is the primary path */
  }
  try {
    Object.defineProperty(navigator, 'userAgent', {
      get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      configurable: true,
    });
  } catch {
    /* ignore */
  }
  try {
    Object.defineProperty(navigator, 'platform', { get: () => 'iPhone', configurable: true });
  } catch {
    /* ignore */
  }
}
if (typeof sessionStorage !== 'undefined') {
  sessionStorage.removeItem('hisohiso.install.dismissed');
}

const frame = { maxWidth: 380, margin: '0 auto' };

// The single install affordance shown on the channels home: the icon + copy +
// dismiss/install buttons. On iOS the install button opens the share-sheet modal.
export const InstallCard = () => (
  <div style={frame}>
    <InstallPrompt />
  </div>
);
