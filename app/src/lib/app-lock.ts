export type PageLifecycleSnapshot = {
  visibilityState: DocumentVisibilityState;
  hasActiveParticipantSecret: boolean;
  isAlreadyLocked: boolean;
};

export const shouldLockForPageLifecycle = ({
  visibilityState,
  hasActiveParticipantSecret,
  isAlreadyLocked,
}: PageLifecycleSnapshot): boolean => {
  return visibilityState === 'hidden' && hasActiveParticipantSecret && !isAlreadyLocked;
};

export type SuspendLockControllerOptions = {
  hasActiveParticipantSecret: () => boolean;
  isAlreadyLocked: () => boolean;
  lock: () => void;
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
};

export const createSuspendLockController = ({
  hasActiveParticipantSecret,
  isAlreadyLocked,
  lock,
  doc = document,
  win = window,
}: SuspendLockControllerOptions): (() => void) => {
  const maybeLock = () => {
    if (
      shouldLockForPageLifecycle({
        visibilityState: doc.visibilityState,
        hasActiveParticipantSecret: hasActiveParticipantSecret(),
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
