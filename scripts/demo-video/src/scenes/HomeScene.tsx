import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import { PhoneFrame } from '../components/PhoneFrame';
import { RoomsPage, StoredRoom } from '../pwa/RoomsPage';
import { C } from '../theme';

// Pastels — match app/src/lib/storage.ts:generatePastelColor (HSL L 75-85%, S 50-70%).
const ROOMS: StoredRoom[] = [
  { roomHash: 'a', nickname: 'work-incidents', color: 'hsl(15, 60%, 80%)', joined: true, handle: 'andrei', relativeTime: '2m ago' },
  { roomHash: 'b', nickname: 'launch crew', color: 'hsl(140, 55%, 80%)', joined: true, handle: 'andrei', relativeTime: '1h ago' },
  { roomHash: 'c', nickname: 'sunday strollers', color: 'hsl(220, 60%, 82%)', joined: false, relativeTime: '3d ago' },
];

export const HomeScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const phoneIn = spring({ frame, fps, config: { damping: 22, stiffness: 110 } });
  const cap = interpolate(frame, [10, 30], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          top: 80,
          width: '100%',
          textAlign: 'center',
          opacity: cap,
        }}
      >
        <div style={{ fontSize: 36, color: C.inkSoft, fontWeight: 500, letterSpacing: '-0.01em' }}>
          Your channels
        </div>
        <div style={{ marginTop: 10, fontSize: 22, color: C.inkDim }}>
          stored on this device only
        </div>
      </div>

      <div
        style={{
          opacity: phoneIn,
          transform: `translateY(${interpolate(phoneIn, [0, 1], [60, 0])}px)`,
          width: '100%',
          height: '100%',
        }}
      >
        <PhoneFrame scale={0.92} translateY={50}>
          <RoomsPage rooms={ROOMS} />
        </PhoneFrame>
      </div>
    </AbsoluteFill>
  );
};
