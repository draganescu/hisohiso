import { useState } from 'react';
import { deriveRoomHash, generateRoomSecret } from '../lib/crypto';
import { setHandle, setToken, setSubscriberJwt, updateRoomNickname, upsertRoom } from '../lib/storage';
import { navigateTo } from '../lib/navigation';

const RoomCreator = () => {
  const [status, setStatus] = useState<'form' | 'creating' | 'error'>('form');
  const [error, setError] = useState<string>('');
  const [roomName, setRoomName] = useState('');
  const [nickname, setNickname] = useState('');

  const create = async () => {
    setStatus('creating');
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
      // Persist before navigating so RoomController's optimistic init path
      // picks the local labels up on first paint. Security and delivery options
      // are nudged inside the room instead of blocking creation here.
      const trimmedName = roomName.trim();
      const trimmedNickname = nickname.trim().slice(0, 24);
      upsertRoom(hash, secret, trimmedNickname || null, 'chat');
      if (trimmedName) {
        updateRoomNickname(hash, trimmedName);
      }
      if (trimmedNickname) {
        setHandle(hash, trimmedNickname);
      }

      navigateTo(`/room#${secret}`);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'unable to open the channel');
    }
  };

  // The real secret is only minted inside create(); pre-create we show a
  // faithful representation of the room URL shape so the "link is the key"
  // idea reads true without inventing a usable link. The host mirrors wherever
  // the app is served; the fragment is a stand-in of the right shape/length.
  const linkHost =
    typeof window !== 'undefined' && window.location.host
      ? window.location.host
      : 'hisohiso.org';
  const sampleFragment = 'xK7p…q2Rf';

  return (
    <main className="app-page app-chrome text-ink">
      <div className="mx-auto flex max-w-xl flex-col gap-6 px-5 py-10 sm:px-6 sm:py-16">
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[0.6875rem] uppercase tracking-[0.35em] text-accent-strong">
              hisohiso
            </p>
            <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.025em]">
              open a channel
            </h1>
            <p className="mt-2 text-sm text-ink-soft">
              name it, choose how you show up, then invite people from inside.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="inline-flex items-center rounded-full border border-lime bg-surface px-2.5 py-1 font-mono text-[0.625rem] uppercase tracking-[0.18em] text-ink-soft">
                no signup
              </span>
              <span className="inline-flex items-center rounded-full border border-accent/40 bg-accent-soft px-2.5 py-1 font-mono text-[0.625rem] uppercase tracking-[0.18em] text-accent-strong">
                link = key
              </span>
            </div>
          </div>
          <a
            className="mt-1 shrink-0 rounded-full border border-rule bg-surface px-4 py-2 text-xs font-medium text-ink no-underline transition hover:border-ink"
            href="/rooms"
          >
            ← your rooms
          </a>
        </header>

        {status === 'form' && (
          <div className="glass-panel rounded-[28px] p-7">
            <div className="rounded-[14px] border border-rule bg-bg p-4">
              <p className="font-display text-sm font-semibold tracking-[-0.01em]">
                the link is the key
              </p>
              <p className="mt-1 text-xs leading-5 text-ink-soft">
                your channel lives at a link like this. tap it and you're in — no
                account, no password prompt.
              </p>
              <p className="mt-3 font-mono text-[0.625rem] uppercase tracking-[0.18em] text-ink-fade">
                example
              </p>
              <div className="mt-1 overflow-x-auto rounded-[12px] border border-rule bg-surface px-3 py-2.5">
                <p className="whitespace-nowrap font-mono text-sm">
                  <span className="text-ink-dim">https://{linkHost}/room</span>
                  <span className="text-ink-dim">#</span>
                  <span className="rounded-[5px] bg-lime/25 px-1 py-0.5 text-ink decoration-clone">
                    {sampleFragment}
                  </span>
                </p>
              </div>
              <p className="mt-2.5 flex items-start gap-1.5 text-[0.6875rem] leading-4 text-ink-soft">
                <span className="mt-px h-2 w-2 shrink-0 rounded-full bg-lime" aria-hidden="true" />
                the part after <span className="font-mono text-ink">#</span> never leaves your
                phone
              </p>
            </div>

            <div className="mt-4 rounded-[14px] border border-rule bg-bg p-4">
              <p className="font-display text-sm font-semibold tracking-[-0.01em]">room name</p>
              <p className="mt-1 text-xs leading-5 text-ink-soft">
                stored on this device so the room is easy to find later.
              </p>
              <input
                className="input-field mt-3 w-full rounded-[14px] px-3 py-2 text-base"
                placeholder="weekend plans"
                type="text"
                name="room-name"
                autoComplete="off"
                autoCorrect="on"
                autoCapitalize="sentences"
                value={roomName}
                onChange={(event) => setRoomName(event.target.value)}
              />
            </div>

            <div className="mt-4 rounded-[14px] border border-rule bg-bg p-4">
              <p className="font-display text-sm font-semibold tracking-[-0.01em]">your nickname</p>
              <p className="mt-1 text-xs leading-5 text-ink-soft">
                shown above messages you send. you can change it later.
              </p>
              <input
                className="input-field mt-3 w-full rounded-[14px] px-3 py-2 text-base"
                placeholder="andrei"
                type="text"
                name="nickname"
                autoComplete="nickname"
                autoCorrect="off"
                autoCapitalize="words"
                maxLength={24}
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
              />
            </div>

            <button
              type="button"
              onClick={() => void create()}
              className="mt-6 w-full btn-primary"
            >
              open channel
            </button>

            <p className="mt-4 text-center text-xs text-ink-dim">
              <a className="underline decoration-rule underline-offset-4 hover:text-ink" href="https://www.hisohiso.org/security/">
                how the encryption works
              </a>
            </p>
          </div>
        )}
        {status === 'creating' && (
          <div className="glass-panel rounded-[28px] p-8">
            <p className="text-sm uppercase tracking-[0.32em] text-ink-dim">opening channel…</p>
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
