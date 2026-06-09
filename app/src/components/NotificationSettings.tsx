import { useCallback, useEffect, useState } from 'react';
import { disablePush, enablePush, getPushStatus, type PushStatus } from '../lib/push';

// App-level notifications switch for the channels home (sits below the app
// lock). Notifications are per-device, not per-room: one browser subscription +
// one OS permission cover every channel. See lib/push.ts for the model.
const NotificationSettings = () => {
  const [status, setStatus] = useState<PushStatus>('off');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void getPushStatus().then(setStatus);
  }, []);

  const on = status === 'on';
  const blocked = status === 'unsupported' || status === 'denied';

  const toggle = useCallback(async () => {
    if (busy || blocked) return;
    setBusy(true);
    setError('');
    try {
      if (on) {
        await disablePush();
      } else {
        await enablePush();
      }
      setStatus(await getPushStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change notifications.');
      setStatus(await getPushStatus());
    } finally {
      setBusy(false);
    }
  }, [busy, blocked, on]);

  const statusLine =
    status === 'unsupported'
      ? 'Not available on this browser.'
      : status === 'denied'
        ? 'Blocked — allow notifications for this site in your browser settings.'
        : on
          ? 'On — this device is alerted when a channel has new activity.'
          : 'Off — this device gets no notifications.';

  return (
    <section className="rounded-[22px] border border-rule bg-surface p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Notifications</h2>
          <p className="mt-2 text-sm text-ink-soft">
            Get a push on this device when a new message lands in any of your channels
            while the app is closed. Applies to every channel on this device; the alert
            itself carries no message content.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Toggle notifications"
          onClick={() => void toggle()}
          disabled={busy || blocked}
          className={`relative mt-1 h-7 w-12 shrink-0 rounded-full transition ${
            on ? 'bg-ink' : 'bg-ink-fade'
          } ${busy || blocked ? 'opacity-50' : ''}`}
        >
          <span
            className={`absolute top-1 h-5 w-5 rounded-full bg-surface transition-all ${
              on ? 'left-6' : 'left-1'
            }`}
          />
        </button>
      </div>

      <p className="mt-3 text-xs uppercase tracking-[0.15em] text-ink-dim">{statusLine}</p>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
};

export default NotificationSettings;
