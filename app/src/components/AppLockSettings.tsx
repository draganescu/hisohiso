import { useCallback, useEffect, useState } from 'react';
import { getAppLockConfig, markAppUnlockedForSession, setAppLockConfig, type AppLockConfig } from '../lib/storage';
import { hashPin } from '../lib/app-pin';
import {
  clearStoredPasskeyCredential,
  enrollPasskey,
  getStoredPasskeyCredential,
  isPasskeySupported,
} from '../lib/app-passkey';

// Global app-lock settings card for the home screen. The lock applies to the
// whole app, not a single room. Default-on; it activates once a PIN is set, and
// a passkey is enrolled as the fast path where the device supports one.
const AppLockSettings = () => {
  const [config, setConfig] = useState<AppLockConfig>(getAppLockConfig);
  const [hasPasskey, setHasPasskey] = useState<boolean>(() => Boolean(getStoredPasskeyCredential()));
  const [setupOpen, setSetupOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const passkeySupported = isPasskeySupported();
  const configured = Boolean(config.pin);
  const active = config.enabled && configured;

  const persist = useCallback((next: AppLockConfig) => {
    setAppLockConfig(next);
    setConfig(next);
  }, []);

  const closeSetup = useCallback(() => {
    setSetupOpen(false);
    setPin('');
    setConfirmPin('');
    setError(null);
  }, []);

  const toggle = useCallback(() => {
    setStatus(null);
    if (config.enabled) {
      persist({ ...config, enabled: false });
      return;
    }
    persist({ ...config, enabled: true });
    if (!config.pin) setSetupOpen(true);
  }, [config, persist]);

  const saveSetup = useCallback(async () => {
    const a = pin.trim();
    const b = confirmPin.trim();
    if (a.length < 4) {
      setError('Use a PIN of at least 4 digits.');
      return;
    }
    if (a !== b) {
      setError('PINs do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    const pinRecord = await hashPin(a);
    let enrolledPasskey = hasPasskey;
    // Enroll a passkey as the fast path on first setup, where supported.
    if (passkeySupported && !hasPasskey) {
      try {
        await enrollPasskey();
        enrolledPasskey = true;
      } catch {
        // Non-fatal: PIN still protects the app.
      }
    }
    persist({ enabled: true, pin: pinRecord });
    // Setting a PIN arms the lock immediately; the user is obviously present, so
    // count this session as unlocked rather than bouncing them to the lock
    // screen on their next navigation.
    markAppUnlockedForSession();
    setHasPasskey(enrolledPasskey);
    setBusy(false);
    closeSetup();
    setStatus(enrolledPasskey ? 'App lock on — passkey + PIN.' : 'App lock on — PIN only.');
  }, [pin, confirmPin, passkeySupported, hasPasskey, persist, closeSetup]);

  const addPasskey = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    try {
      await enrollPasskey();
      setHasPasskey(true);
      setStatus('Passkey unlock enabled.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not enroll a passkey. PIN still works.');
    } finally {
      setBusy(false);
    }
  }, []);

  const removePasskey = useCallback(() => {
    clearStoredPasskeyCredential();
    setHasPasskey(false);
    setStatus('Passkey unlock removed. PIN still works.');
  }, []);

  const statusLine = !config.enabled
    ? 'Off — the app will not lock when suspended.'
    : !configured
      ? 'On, but set a PIN to activate.'
      : hasPasskey
        ? 'On — unlocks with your passkey or PIN.'
        : 'On — unlocks with your PIN.';

  return (
    <section className="rounded-[22px] border border-rule bg-surface p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">App lock</h2>
          <p className="mt-2 text-sm text-ink-soft">
            Locks the whole app when it is suspended or backgrounded — so a phone
            left unlocked in the app switcher can&apos;t be opened without your
            passkey or PIN.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={config.enabled}
          aria-label="Toggle app lock"
          onClick={toggle}
          className={`relative mt-1 h-7 w-12 shrink-0 rounded-full transition ${
            config.enabled ? 'bg-ink' : 'bg-ink-fade'
          }`}
        >
          <span
            className={`absolute top-1 h-5 w-5 rounded-full bg-surface transition-all ${
              config.enabled ? 'left-6' : 'left-1'
            }`}
          />
        </button>
      </div>

      <p className="mt-3 text-xs uppercase tracking-[0.15em] text-ink-dim">{statusLine}</p>
      {status && <p className="mt-2 text-xs text-ink-soft">{status}</p>}

      {config.enabled && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setStatus(null);
              setSetupOpen(true);
            }}
            className="rounded-full border border-ink px-4 py-2 text-xs font-semibold"
          >
            {configured ? 'Change PIN' : 'Set PIN'}
          </button>
          {active && passkeySupported && !hasPasskey && (
            <button
              type="button"
              onClick={() => void addPasskey()}
              disabled={busy}
              className="rounded-full border border-ink px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
            >
              Add passkey unlock
            </button>
          )}
          {active && hasPasskey && (
            <button
              type="button"
              onClick={removePasskey}
              disabled={busy}
              className="rounded-full border border-ink px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
            >
              Remove passkey
            </button>
          )}
        </div>
      )}

      {config.enabled && !passkeySupported && (
        <p className="mt-3 text-xs text-ink-dim">
          This device has no passkey/biometric support, so unlock uses your PIN.
        </p>
      )}

      {setupOpen && (
        <div className="mt-4 rounded-xl border border-rule bg-bg p-4">
          <p className="text-sm font-semibold">{configured ? 'Change PIN' : 'Set a PIN'}</p>
          <p className="mt-1 text-xs text-ink-dim">
            At least 4 digits.{' '}
            {passkeySupported
              ? 'A passkey is enrolled as the fast path; the PIN is the fallback.'
              : 'Used to unlock on this device.'}
          </p>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder="PIN"
            value={pin}
            onChange={(e) => {
              setPin(e.target.value);
              if (error) setError(null);
            }}
            className="mt-3 w-full rounded-full border border-rule bg-surface px-4 py-2 text-sm tracking-[0.2em]"
          />
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder="Confirm PIN"
            value={confirmPin}
            onChange={(e) => {
              setConfirmPin(e.target.value);
              if (error) setError(null);
            }}
            className="mt-2 w-full rounded-full border border-rule bg-surface px-4 py-2 text-sm tracking-[0.2em]"
          />
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void saveSetup()}
              disabled={busy}
              className="rounded-full border border-ink bg-ink px-4 py-2 text-xs font-semibold text-on-ink disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={closeSetup}
              disabled={busy}
              className="rounded-full border border-ink px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
};

export default AppLockSettings;
