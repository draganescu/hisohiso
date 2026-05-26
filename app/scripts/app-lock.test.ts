import { shouldLockForPageLifecycle, shouldStartLocked, type PageLifecycleSnapshot } from '../src/lib/app-lock.js';

const assertEqual = (actual: unknown, expected: unknown, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
};

const hidden = (overrides: Partial<PageLifecycleSnapshot> = {}): PageLifecycleSnapshot => ({
  visibilityState: 'hidden',
  isArmed: true,
  isAlreadyLocked: false,
  ...overrides,
});

assertEqual(
  shouldLockForPageLifecycle(hidden()),
  true,
  'locks when an armed app is suspended or hidden'
);

assertEqual(
  shouldLockForPageLifecycle(hidden({ visibilityState: 'visible' })),
  false,
  'does not lock while the app remains visible'
);

assertEqual(
  shouldLockForPageLifecycle(hidden({ isArmed: false })),
  false,
  'does not lock when the app lock is disabled or unconfigured'
);

assertEqual(
  shouldLockForPageLifecycle(hidden({ isAlreadyLocked: true })),
  false,
  'does not re-lock repeatedly while already locked'
);

assertEqual(
  shouldStartLocked({ isArmed: true, isUnlockedForSession: false }),
  true,
  'starts locked when armed and the session has not been unlocked (fresh launch)'
);

assertEqual(
  shouldStartLocked({ isArmed: true, isUnlockedForSession: true }),
  false,
  'stays unlocked across in-app navigation once the session is unlocked'
);

assertEqual(
  shouldStartLocked({ isArmed: false, isUnlockedForSession: false }),
  false,
  'never starts locked when the lock is disabled or unconfigured'
);

console.log('app-lock behavior ok');
