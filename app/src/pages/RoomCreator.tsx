import { useState } from 'react';
import { deriveRoomHash, generateRoomSecret } from '../lib/crypto';
import { setToken, setSubscriberJwt } from '../lib/storage';

const RoomCreator = () => {
  const [status, setStatus] = useState<'form' | 'creating' | 'error'>('form');
  const [error, setError] = useState<string>('');
  const [catchUp, setCatchUp] = useState(false);

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

      window.location.href = `/room#${secret}`;
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Unable to create room');
    }
  };

  return (
    <main className="min-h-screen bg-[#efe7d5] text-[#171613]">
      <div className="mx-auto flex max-w-xl flex-col gap-4 px-6 py-16">
        {status === 'form' && (
          <div className="rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-8">
            <h1 className="text-2xl font-semibold">New room</h1>
            <p className="mt-2 text-sm text-[#3a362f]">
              Messages stay on this device only. Anyone with the link can join.
            </p>

            <div className="mt-6 flex items-center justify-between gap-3 rounded-xl border border-[#1716131f] bg-[#fefaf2] p-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">Offline catch-up</p>
                <p className="mt-1 text-xs text-[#3a362f]">
                  Keep encrypted messages on the server for 24h so devices that were closed
                  can catch up. You can change this later from the room menu.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={catchUp}
                onClick={() => setCatchUp((v) => !v)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  catchUp ? 'bg-[#d9592f]' : 'bg-[#1716133d]'
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                    catchUp ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>

            <button
              type="button"
              onClick={() => void create()}
              className="mt-6 w-full rounded-full bg-[#171613] py-3 text-sm font-semibold text-[#f6f0e8]"
            >
              Create room
            </button>
          </div>
        )}
        {status === 'creating' && (
          <div className="rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-8">
            <p className="text-sm uppercase tracking-[0.3em] text-[#3a362f]">Creating room…</p>
          </div>
        )}
        {status === 'error' && (
          <div className="rounded-2xl border border-[#b43d1f] bg-[#f7e7e1] p-6 text-sm text-[#6b2411]">
            {error}
          </div>
        )}
      </div>
    </main>
  );
};

export default RoomCreator;
