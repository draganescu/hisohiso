import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import { PhoneFrame } from '../components/PhoneFrame';
import { JoinForm } from '../pwa/JoinForm';
import { C } from '../theme';

export const KnockScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const phoneIn = spring({ frame, fps, config: { damping: 22, stiffness: 110 } });
  const cap = interpolate(frame, [10, 30], [0, 1], { extrapolateRight: 'clamp' });

  const keyText = 'hush-hush';
  const keyTyped = keyText.slice(0, Math.max(0, Math.min(keyText.length, Math.floor((frame - 40) / 4))));

  const noteText = 'hey it’s Mira from work';
  const noteTyped = noteText.slice(0, Math.max(0, Math.min(noteText.length, Math.floor((frame - 90) / 3))));

  const knockSent = frame > 160;

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
          A new device knocks
        </div>
        <div style={{ marginTop: 10, fontSize: 22, color: C.inkDim }}>
          knock is encrypted with the channel key
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
        <PhoneFrame scale={0.92} translateY={50} time="9:42">
          <JoinForm roomKey={keyTyped} note={noteTyped} knockSent={knockSent} />
        </PhoneFrame>
      </div>
    </AbsoluteFill>
  );
};
