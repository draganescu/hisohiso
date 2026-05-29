import { useState } from 'react';
import { deriveRoomHash, generateRoomSecret } from '../lib/crypto';
import { setRoomPassword, setToken, setSubscriberJwt } from '../lib/storage';
import { navigateTo } from '../lib/navigation';

const RoomCreator = () => {
  const [status, setStatus] = useState<'form' | 'creating' | 'error'>('form');
  const [error, setError] = useState<string>('');
  const [catchUp, setCatchUp] = useState(false);
  const [roomKey, setRoomKey] = useState('');

  const create = async () => {
    setStatus('creating');
    try {
      const secret = generateRoomSecret();
      const hash = await deriveRoomHash(secret);

      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_hash: hash, catch_up: catchUp })
      });

      if (!response.ok) {
        throw new Error(`Server responded ${response.status}`);
      }

      const data = (await response.json()) as {
        participant_token?: string;
        subscriber_jwt?: string;
      };

      if (data.participant_token) {
        setToken(hash, data.participant_token);
      }
      if (data.subscriber_jwt) {
        setSubscriberJwt(hash, data.subscriber_jwt);
      }
      // Persist before navigating so RoomController's optimistic init path
      // picks the key up on first paint instead of deriving with an empty
      // string and re-deriving on the next render.
      const trimmedKey = roomKey.trim();
      if (trimmedKey) {
        setRoomPassword(hash, trimmedKey);
      }

      navigateTo(`/room#${secret}`);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Unable to open the channel');
    }
  };

  return (
    <main className="app-page app-chrome text-ink">
      <div className="mx-auto flex max-w-xl flex-col gap-6 px-5 py-10 sm:px-6 sm:py-16">
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.35em] text-ink-dim">hisohiso</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.025em]">Open a channel.</h1>
            <p className="mt-2 text-sm text-ink-soft">
              Messages stay on this device only. Anyone with the link can join.
            </p>
          </div>
          <a
            className="mt-1 shrink-0 rounded-full border border-rule bg-surface px-4 py-2 text-xs font-medium text-ink no-underline transition hover:border-ink"
            href="/rooms"
          >
            ← Your channels
          </a>
        </header>

        {status === 'form' && (
          <div className="glass-panel rounded-[28px] p-7">
            <div className="rounded-[14px] border border-rule bg-bg p-4">
              <p className="text-sm font-semibold tracking-[-0.01em]">Channel key</p>
              <p className="mt-1 text-xs leading-5 text-ink-soft">
                Optional. Encrypts knocks and message blocks. Everyone joining needs the
                same key — share it out of band.
              </p>
              <input
                className="input-field mt-3 w-full rounded-[14px] px-3 py-2 text-base"
                placeholder="Optional"
                type="text"
                name="room-key"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore=""
                data-lpignore="true"
                value={roomKey}
                onChange={(event) => setRoomKey(event.target.value)}
              />
            </div>

            <div className="mt-4 flex items-center justify-between gap-3 rounded-[14px] border border-rule bg-bg p-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold tracking-[-0.01em]">Offline catch-up</p>
                <p className="mt-1 text-xs leading-5 text-ink-soft">
                  Server keeps encrypted messages for 24h so devices that were closed
                  can catch up. You can change this later.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={catchUp}
                onClick={() => setCatchUp((v) => !v)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  catchUp ? 'bg-ink' : 'bg-overlay-soft'
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-surface shadow transition-transform ${
                    catchUp ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>

            <button
              type="button"
              onClick={() => void create()}
              className="mt-6 w-full rounded-full border border-ink bg-filled py-3 text-sm font-medium text-on-ink transition hover:bg-transparent hover:text-ink"
            >
              Open channel
            </button>

            <p className="mt-4 text-center text-xs text-ink-dim">
              <a className="underline decoration-rule underline-offset-4 hover:text-ink" href="/security/">
                How the encryption works
              </a>
            </p>
          </div>
        )}
        {status === 'creating' && (
          <div className="glass-panel rounded-[28px] p-8">
            <p className="text-sm uppercase tracking-[0.32em] text-ink-dim">Opening channel…</p>
          </div>
        )}
        {status === 'error' && (
          <div className="rounded-[22px] border border-danger bg-danger-soft p-6 text-sm text-danger">
            {error}
          </div>
        )}
      </div>
    </main>
  );
};

export default RoomCreator;
