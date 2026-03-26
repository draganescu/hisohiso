import { useEffect, useState } from 'react';
import { deriveRoomHash, generateRoomSecret } from '../lib/crypto';
import { setToken } from '../lib/storage';

const RoomCreator = () => {
  const [status, setStatus] = useState<'creating' | 'error'>('creating');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const create = async () => {
      try {
        const secret = generateRoomSecret();
        const hash = await deriveRoomHash(secret);

        const response = await fetch('/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ room_hash: hash })
        });

        if (!response.ok) {
          throw new Error(`Server responded ${response.status}`);
        }

        const data = (await response.json()) as {
          participant_token?: string;
        };

        if (data.participant_token) {
          setToken(hash, data.participant_token);
        }

        window.location.href = `/#/${secret}`;
      } catch (err) {
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Unable to create room');
      }
    };

    void create();
  }, []);

  return (
    <main className="min-h-screen bg-[#efe7d5] text-[#171613]">
      <div className="mx-auto flex max-w-xl flex-col px-6 py-16">
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
