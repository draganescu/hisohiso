import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import { PhoneFrame } from '../components/PhoneFrame';
import { RoomCreator } from '../pwa/RoomCreator';
import { C } from '../theme';

export const CreateScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const phoneIn = spring({ frame, fps, config: { damping: 22, stiffness: 120 } });
  const cap = interpolate(frame, [10, 30], [0, 1], { extrapolateRight: 'clamp' });

  // Type the channel key
  const keyText = 'hush-hush';
  const typedLen = Math.max(0, Math.min(keyText.length, Math.floor((frame - 40) / 4)));
  const typed = keyText.slice(0, typedLen);

  // Catch-up toggle flips on
  const toggleOn = frame > 95;

  // Status flip to "creating" after press at ~135
  const status: 'form' | 'creating' = frame > 135 ? 'creating' : 'form';

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
          Open a channel
        </div>
        <div style={{ marginTop: 10, fontSize: 22, color: C.inkDim }}>
          optional key · optional catch-up
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
          <RoomCreator roomKey={typed} catchUp={toggleOn} status={status} />
        </PhoneFrame>
      </div>
    </AbsoluteFill>
  );
};
