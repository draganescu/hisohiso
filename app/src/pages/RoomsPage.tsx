import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getToken, listRooms, removeRoom, type StoredRoom } from '../lib/storage';

const RoomsPage = () => {
  const [rooms, setRooms] = useState<StoredRoom[]>([]);
  const [joinValue, setJoinValue] = useState('');
  const [joinError, setJoinError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    setRooms(listRooms());
  }, []);

  const handleForget = (roomHash: string) => {
    removeRoom(roomHash);
    setRooms(listRooms());
  };

  const handleJoin = () => {
    const trimmed = joinValue.trim();
    if (!trimmed) {
      setJoinError('Paste a room link or secret.');
      return;
    }
    let secret = trimmed;
    try {
      if (trimmed.includes('://')) {
        const url = new URL(trimmed);
        secret = url.pathname.replace(/^\//, '');
      }
    } catch {
      // If URL parsing fails, treat as raw secret.
      secret = trimmed;
    }
    if (!secret) {
      setJoinError('Invalid link or secret.');
      return;
    }
    setJoinError('');
    navigate(`/${secret}`);
  };

  return (
    <main className="min-h-screen bg-[#efe7d5] text-[#171613]">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-16">
        <header>
          <p className="text-xs uppercase tracking-[0.3em] text-[#3a362f]">Chat for All</p>
          <h1 className="mt-3 text-3xl font-semibold">Your rooms</h1>
          <p className="mt-2 text-sm text-[#3a362f]">Stored locally on this device only.</p>
        </header>

        <section className="rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-6 shadow-[0_10px_24px_rgba(23,22,19,0.1)]">
          <h2 className="text-lg font-semibold">Join with a link</h2>
          <p className="mt-2 text-sm text-[#3a362f]">Paste a room URL or secret to join.</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input
              className="flex-1 rounded-full border border-[#17161333] bg-white/80 px-4 py-2 text-sm"
              placeholder="https://hisohiso.org/ROOM_SECRET"
              value={joinValue}
              onChange={(event) => setJoinValue(event.target.value)}
            />
            <button
              className="rounded-full border-2 border-[#171613] bg-[#171613] px-5 py-2 text-sm font-semibold text-[#f6f0e8]"
              onClick={handleJoin}
              type="button"
            >
              Join
            </button>
          </div>
          {joinError && <p className="mt-2 text-xs text-[#6b2411]">{joinError}</p>}
        </section>

        {rooms.length === 0 && (
          <div className="rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-8">
            <p className="text-[#3a362f]">No rooms yet. Start one or join using a link.</p>
            <a className="mt-4 inline-block text-sm underline" href="/new">
              Start a room
            </a>
          </div>
        )}

        {rooms.length > 0 && (
          <div className="flex flex-col gap-4">
            {rooms.map((room) => {
              const hasToken = !!getToken(room.roomHash);
              return (
                <div
                  key={room.roomHash}
                  className="rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-6 shadow-[0_10px_24px_rgba(23,22,19,0.1)]"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-[#3a362f]">
                        {hasToken ? 'Participant' : 'Link saved'}
                      </p>
                      <p className="mt-2 text-sm text-[#3a362f]">{room.handle ? `Handle: ${room.handle}` : 'No handle set'}</p>
                      <p className="mt-2 text-xs text-[#6a6358]">
                        Last opened {new Date(room.lastSeen * 1000).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <a
                        className="rounded-full border-2 border-[#171613] bg-[#171613] px-4 py-2 text-xs font-semibold text-[#f6f0e8]"
                        href={`/${room.roomSecret}`}
                      >
                        Open
                      </a>
                      <button
                        className="rounded-full border-2 border-[#171613] px-4 py-2 text-xs font-semibold"
                        onClick={() => handleForget(room.roomHash)}
                        type="button"
                      >
                        Forget
                      </button>
                    </div>
                  </div>
                  <p className="mt-4 break-all text-xs text-[#3a362f]">{room.roomSecret}</p>
                </div>
              );
            })}
          </div>
        )}

        <a className="text-sm underline" href="/">
          Back to landing
        </a>
      </div>
    </main>
  );
};

export default RoomsPage;
