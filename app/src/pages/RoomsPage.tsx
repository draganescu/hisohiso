import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import jsQR from 'jsqr';
import { listRooms, removeRoom, updateRoomNickname, type StoredRoom } from '../lib/storage';
import { navigateTo } from '../lib/navigation';
import AppLockSettings from '../components/AppLockSettings';
import ThemeToggle from '../components/ThemeToggle';
import { RoomRow } from '../components/RoomRow';

const hasCamera = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

const extractSecret = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let secret = trimmed;
  try {
    if (trimmed.includes('://')) {
      const url = new URL(trimmed);
      // Support hash-based URLs: hisohiso.org/room#SECRET
      const hashSecret = url.hash.replace(/^#\/?/, '');
      if (hashSecret) {
        secret = hashSecret;
      } else {
        // Fallback for old path-based URLs: hisohiso.org/SECRET
        secret = url.pathname.replace(/^\/(room\/?)?/, '');
      }
    }
  } catch {
    secret = trimmed;
  }
  return secret || null;
};

const RoomsPage = () => {
  const [rooms, setRooms] = useState<StoredRoom[]>([]);
  const [joinValue, setJoinValue] = useState('');
  const [joinError, setJoinError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    setRooms(listRooms());
  }, []);

  const handleForget = (roomHash: string) => {
    removeRoom(roomHash);
    setRooms(listRooms());
  };

  const handleJoin = () => {
    const secret = extractSecret(joinValue);
    if (!secret) {
      setJoinError('Paste a channel link or secret.');
      return;
    }
    setJoinError('');
    navigateTo(`/room#${secret}`);
  };

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setScanning(false);
  }, []);

  const startScan = useCallback(async () => {
    setScanError('');
    setScanning(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      streamRef.current = stream;

      if (!videoRef.current) {
        stopCamera();
        return;
      }

      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();

      const canvas = canvasRef.current!;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

      let active = true;
      const tick = () => {
        if (!active || !videoRef.current || video.readyState < 2) {
          if (active) requestAnimationFrame(tick);
          return;
        }
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, canvas.width, canvas.height);
        if (code) {
          const secret = extractSecret(code.data);
          if (secret) {
            active = false;
            stopCamera();
            navigateTo(`/room#${secret}`);
            return;
          }
        }
        if (active) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      return () => {
        active = false;
      };
    } catch {
      setScanError('Camera access denied.');
      stopCamera();
    }
  }, [navigate, stopCamera]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  const renderRoomRow = (room: StoredRoom) => (
    <RoomRow
      key={room.roomHash}
      room={room}
      href={`/room#${room.roomSecret}`}
      onRename={(next) => {
        updateRoomNickname(room.roomHash, next);
        setRooms(listRooms());
      }}
      onForget={() => handleForget(room.roomHash)}
    />
  );

  // Open channels = the live operator surface (the daemon control room and the
  // agent rooms it spawned). Plain peer conversations list separately below.
  const openChannels = rooms.filter((room) => room.kind !== 'chat');
  const conversations = rooms.filter((room) => room.kind === 'chat');

  return (
    <main className="app-page app-chrome text-ink">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 px-5 py-10 sm:px-6 sm:py-16">
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[0.6875rem] uppercase tracking-[0.35em] text-ink-dim">hisohiso</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.025em]">Your channels.</h1>
            <p className="mt-2 text-sm text-ink-soft">Stored on this device only.</p>
          </div>
          <a
            className="mt-1 shrink-0 rounded-full border border-ink bg-filled px-5 py-2.5 text-sm font-medium text-on-ink transition hover:bg-transparent hover:text-ink"
            href="/new"
          >
            Open a channel
          </a>
        </header>

        <section className="glass-panel rounded-[28px] p-6">
          <h2 className="text-lg font-semibold tracking-[-0.015em]">Join with a link.</h2>
          <p className="mt-2 text-sm text-ink-soft">Paste a channel URL or secret.</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input
              className="form-zoom-safe input-field flex-1 rounded-full px-4 py-2.5"
              placeholder="https://hisohiso.org/room#…"
              value={joinValue}
              onChange={(event) => setJoinValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleJoin();
              }}
            />
            <button
              className="rounded-full border border-ink bg-filled px-5 py-2.5 text-sm font-medium text-on-ink transition hover:bg-transparent hover:text-ink"
              onClick={handleJoin}
              type="button"
            >
              Join
            </button>
          </div>
          {joinError && <p className="mt-2 text-xs text-danger">{joinError}</p>}

          <canvas ref={canvasRef} className="hidden" />
          {hasCamera && !scanning && (
            <button
              className="mt-4 rounded-full border border-rule bg-surface px-5 py-2 text-sm font-medium text-ink transition hover:border-ink"
              onClick={() => void startScan()}
              type="button"
            >
              Scan QR code
            </button>
          )}

          {scanning && (
            <div className="mt-4">
              <div className="relative overflow-hidden rounded-2xl bg-black">
                <video
                  ref={videoRef}
                  className="w-full"
                  playsInline
                  muted
                  style={{ maxHeight: '320px', objectFit: 'cover' }}
                />
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="h-48 w-48 rounded-2xl border border-surface/50" />
                </div>
              </div>
              <button
                className="mt-3 rounded-full border border-rule bg-surface px-5 py-2 text-sm font-medium text-ink"
                onClick={stopCamera}
                type="button"
              >
                Stop scanning
              </button>
            </div>
          )}

          {scanError && <p className="mt-2 text-xs text-danger">{scanError}</p>}
        </section>

        {rooms.length === 0 && (
          <div className="glass-panel rounded-[28px] border-dashed p-8">
            <p className="text-ink-soft">No channels yet. Open one or paste a link above.</p>
            <a className="mt-4 inline-block text-sm font-medium text-ink underline decoration-rule underline-offset-4" href="/new">
              Open a channel →
            </a>
          </div>
        )}

        {openChannels.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="px-1 text-[0.6875rem] font-semibold uppercase tracking-[0.32em] text-ink-dim">
              Open channels
            </h2>
            {openChannels.map(renderRoomRow)}
          </section>
        )}

        {conversations.length > 0 && (
          <section className="flex flex-col gap-3">
            {openChannels.length > 0 && (
              <h2 className="px-1 text-[0.6875rem] font-semibold uppercase tracking-[0.32em] text-ink-dim">
                Conversations
              </h2>
            )}
            {conversations.map(renderRoomRow)}
          </section>
        )}

        <AppLockSettings />

        <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 text-xs text-ink-dim">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <a className="font-medium text-ink-soft underline decoration-rule underline-offset-4 hover:text-ink" href="/">
              What is hisohiso?
            </a>
            <a className="font-medium text-ink-soft underline decoration-rule underline-offset-4 hover:text-ink" href="/security/">
              Protocol
            </a>
            <a className="font-medium text-ink-soft underline decoration-rule underline-offset-4 hover:text-ink" href="https://github.com/draganescu/hisohiso">
              Source
            </a>
          </div>
          <ThemeToggle variant="pill" />
        </div>
      </div>
    </main>
  );
};

export default RoomsPage;
