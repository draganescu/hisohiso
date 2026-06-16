import { useEffect, useRef, useState } from 'react';
import { deriveRoomHash, generateRoomSecret } from '../lib/crypto';
import { setToken, setSubscriberJwt, upsertRoom } from '../lib/storage';
import { navigateTo } from '../lib/navigation';

// Creating a channel no longer asks for a name or nickname up front. The room
// opens immediately and the in-room setup nudge (security + delivery) plus the
// kebab → Rename action cover everything the old form used to collect, so the
// intermediary screen would just be a step between two taps. This route now
// mints the room on mount and drops the user straight into it; every existing
// `/new` link keeps working and simply skips the form.
const RoomCreator = () => {
  const [status, setStatus] = useState<'creating' | 'error'>('creating');
  const [error, setError] = useState<string>('');
  // StrictMode mounts effects twice in dev; without this guard we would POST
  // /api/rooms twice and mint two throwaway rooms before navigating.
  const startedRef = useRef(false);

  const create = async () => {
    setStatus('creating');
    setError('');
    try {
      const secret = generateRoomSecret();
      const hash = await deriveRoomHash(secret);

      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_hash: hash, catch_up: false })
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
      // Persist before navigating so RoomController's optimistic init path picks
      // the room up on first paint. Name and nickname stay null — the room shows
      // an auto-generated label until renamed, and the in-room nudge handles the
      // rest.
      upsertRoom(hash, secret, null, 'chat');

      navigateTo(`/room#${secret}`);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'unable to open the channel');
    }
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void create();
  }, []);

  return (
    <main className="app-page app-chrome text-ink">
      <div className="mx-auto flex max-w-xl flex-col gap-6 px-5 py-10 sm:px-6 sm:py-16">
        {status === 'creating' && (
          <div className="glass-panel rounded-[28px] p-8">
            <p className="text-sm uppercase tracking-[0.32em] text-ink-dim">opening channel…</p>
          </div>
        )}
        {status === 'error' && (
          <div className="glass-panel rounded-[28px] p-7">
            <div className="rounded-[22px] border border-danger bg-danger-soft p-6 text-sm text-danger">
              {error}
            </div>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => void create()}
                className="flex-1 btn-primary"
              >
                try again
              </button>
              <a className="flex-1 text-center no-underline btn-ghost" href="/rooms">
                ← your rooms
              </a>
            </div>
          </div>
        )}
      </div>
    </main>
  );
};

export default RoomCreator;
