export type PageLifecycleSnapshot = {
  visibilityState: DocumentVisibilityState;
  // The lock is "armed" when it is enabled and configured (a PIN exists).
  isArmed: boolean;
  isAlreadyLocked: boolean;
};

export const shouldLockForPageLifecycle = ({
  visibilityState,
  isArmed,
  isAlreadyLocked,
}: PageLifecycleSnapshot): boolean => {
  return visibilityState === 'hidden' && isArmed && !isAlreadyLocked;
};

// Decides the lock state at app *startup* (a fresh mount / page load). The app
// starts locked only when the lock is armed AND the current browser session has
// not already been unlocked. The session-unlocked flag lives in sessionStorage,
// which survives in-app navigations (these are full page loads in this
// multi-page PWA) but is wiped when the PWA process is killed — so a relaunch
// starts locked, while tapping "Your rooms" keeps you unlocked. Without this,
// every navigation remounted AppLock and re-locked the app.
export const shouldStartLocked = ({
  isArmed,
  isUnlockedForSession,
}: {
  isArmed: boolean;
  isUnlockedForSession: boolean;
}): boolean => isArmed && !isUnlockedForSession;

export type SuspendLockControllerOptions = {
  isArmed: () => boolean;
  isAlreadyLocked: () => boolean;
  lock: () => void;
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
};

export const createSuspendLockController = ({
  isArmed,
  isAlreadyLocked,
  lock,
  doc = document,
  win = window,
}: SuspendLockControllerOptions): (() => void) => {
  const maybeLock = () => {
    if (
      shouldLockForPageLifecycle({
        visibilityState: doc.visibilityState,
        isArmed: isArmed(),
        isAlreadyLocked: isAlreadyLocked(),
      })
    ) {
      lock();
    }
  };

  doc.addEventListener('visibilitychange', maybeLock);
  win.addEventListener('pagehide', maybeLock);

  return () => {
    doc.removeEventListener('visibilitychange', maybeLock);
    win.removeEventListener('pagehide', maybeLock);
  };
};
