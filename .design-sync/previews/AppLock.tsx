import { AppLock } from 'hisohiso-app';

// AppLock wraps the whole app and renders the LOCK SCREEN when the lock is armed
// and the session is not already unlocked. Armed = config.enabled === true AND a
// config.pin exists (see lib/storage isAppLockArmed); the start-locked decision
// is shouldStartLocked({ isArmed, isUnlockedForSession }) in lib/app-lock.
//
// Seed at module scope so the very first mount evaluates as locked:
//   - hisohiso.app_lock (localStorage): { enabled, pin } → armed
//   - hisohiso.app_unlocked (sessionStorage): removed → not unlocked this session
if (typeof localStorage !== 'undefined') {
  localStorage.setItem(
    'hisohiso.app_lock',
    JSON.stringify({ enabled: true, pin: { salt: 'c2FsdA', hash: 'aGFzaA' } }),
  );
}
if (typeof sessionStorage !== 'undefined') {
  sessionStorage.removeItem('hisohiso.app_unlocked');
}

const frame = { maxWidth: 380, margin: '0 auto' };

// The meaningful cell: with a PIN configured and no session unlock, AppLock
// unmounts its children and shows the PIN-entry lock screen.
export const Locked = () => (
  <div style={frame}>
    <AppLock>
      <div style={{ padding: 24 }}>protected app content</div>
    </AppLock>
  </div>
);

// The passthrough: a child component rendered directly stands in for the
// unlocked state (children rendered verbatim once unlocked).
export const Unlocked = () => (
  <div style={frame}>
    <div
      style={{
        padding: 24,
        borderRadius: 18,
        border: '1px solid var(--rule, #e5e5e5)',
        fontSize: 14,
      }}
    >
      protected app content
    </div>
  </div>
);
