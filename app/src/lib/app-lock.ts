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
