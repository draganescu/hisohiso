import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createSuspendLockController, shouldStartLocked } from '../lib/app-lock';
import {
  clearAppUnlockedForSession,
  clearInAppNavigation,
  getAppLockConfig,
  isAppLockArmed,
  isAppUnlockedForSession,
  isInAppNavigationPending,
  markAppUnlockedForSession,
} from '../lib/storage';
import { getStoredPasskeyCredential, isPasskeySupported, verifyPasskey } from '../lib/app-passkey';
import { verifyPin } from '../lib/app-pin';

type AppLockProps = { children: ReactNode };

// Wraps the whole app. When the lock is armed, the app starts locked on a fresh
// launch (so a backgrounded-then-killed PWA reopens locked) and re-locks every
// time the page is suspended/hidden. A successful unlock is remembered for the
// browser session, so it sticks across in-app navigation (each of which is a
// full page load here) but not across a process kill. While locked, children
// are unmounted entirely — no app state, and no in-memory room keys, stay
// behind the lock screen.
const AppLock = ({ children }: AppLockProps) => {
  const [locked, setLocked] = useState<boolean>(() =>
    shouldStartLocked({ isArmed: isAppLockArmed(), isUnlockedForSession: isAppUnlockedForSession() }),
  );
  const lockedRef = useRef(locked);
  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);

  useEffect(() => {
    // Consume the navigation marker that carried us into this page, so a later
    // genuine backgrounding of THIS page is not mistaken for a navigation.
    clearInAppNavigation();
    return createSuspendLockController({
      // Read config fresh on each suspend so a toggle on the home screen takes
      // effect without a reload.
      isArmed: () => isAppLockArmed(),
      isAlreadyLocked: () => lockedRef.current,
      // A full-page in-app navigation fires the same hide events as
      // backgrounding; skip locking while one is in flight.
      isInAppNavigation: () => isInAppNavigationPending(),
      // Drop the session unlock too: once backgrounded, a reload or relaunch
      // must require the PIN/passkey again.
      lock: () => {
        clearAppUnlockedForSession();
        setLocked(true);
      },
    });
  }, []);

  const unlock = useCallback(() => {
    markAppUnlockedForSession();
    setLocked(false);
  }, []);

  if (locked) {
    return <LockScreen onUnlock={unlock} />;
  }
  return <>{children}</>;
};

const LockScreen = ({ onUnlock }: { onUnlock: () => void }) => {
  const config = getAppLockConfig();
  const passkey = getStoredPasskeyCredential();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const showPasskey = Boolean(passkey) && isPasskeySupported();

  const tryPasskey = useCallback(async () => {
    if (!passkey) return;
    setBusy(true);
    setError(null);
    try {
      await verifyPasskey(passkey);
      onUnlock();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Passkey unlock failed. Enter your PIN.');
    } finally {
      setBusy(false);
    }
  }, [passkey, onUnlock]);

  const submitPin = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      // Defensive: if somehow locked without a configured PIN, fail open rather
      // than trap the user out of their own app.
      if (!config.pin) {
        onUnlock();
        return;
      }
      setBusy(true);
      setError(null);
      const ok = await verifyPin(pin.trim(), config.pin);
      setBusy(false);
      if (ok) {
        setPin('');
        onUnlock();
      } else {
        setError('Incorrect PIN.');
      }
    },
    [config.pin, onUnlock, pin],
  );

  return (
    <main className="min-h-screen bg-[#171613] text-[#f4efe4]">
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-16 text-center">
        <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full border border-[#f4efe455] bg-[#f4efe414] text-3xl">
          🔐
        </div>
        <p className="text-[11px] uppercase tracking-[0.35em] text-[#c9bda8]">Hisohiso locked</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em]">Unlock</h1>
        <p className="mt-3 max-w-sm text-sm leading-6 text-[#d8cebd]">
          The app locked while it was in the background.{' '}
          {showPasskey
            ? 'Use your device passkey or enter your PIN to continue.'
            : 'Enter your PIN to continue.'}
        </p>

        {showPasskey && (
          <button
            type="button"
            onClick={() => void tryPasskey()}
            disabled={busy}
            className="mt-8 w-full rounded-full bg-[#f4efe4] px-5 py-3 text-sm font-semibold text-[#171613] shadow-lg shadow-black/20 transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Unlocking…' : 'Unlock with passkey'}
          </button>
        )}

        <form className={showPasskey ? 'mt-3 w-full' : 'mt-8 w-full'} onSubmit={submitPin}>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus={!showPasskey}
            value={pin}
            onChange={(event) => {
              setPin(event.target.value);
              if (error) setError(null);
            }}
            placeholder="PIN"
            aria-label="App lock PIN"
            className="w-full rounded-full border border-[#f4efe455] bg-[#f4efe414] px-5 py-3 text-center text-sm tracking-[0.3em] text-[#f4efe4] placeholder:tracking-normal placeholder:text-[#c9bda8] focus:border-[#f4efe4] focus:outline-none"
          />
          {error && <p className="mt-3 text-sm text-[#f0a58f]">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="mt-3 w-full rounded-full border border-[#f4efe455] px-5 py-3 text-sm font-semibold text-[#f4efe4] transition hover:bg-[#f4efe414] disabled:cursor-not-allowed disabled:opacity-60"
          >
            Unlock with PIN
          </button>
        </form>
      </div>
    </main>
  );
};

export default AppLock;
