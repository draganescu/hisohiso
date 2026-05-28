import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import { C } from '../theme';

export const IntroScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const wordmark = spring({ frame, fps, config: { damping: 18, stiffness: 90 } });
  const eyebrowOpacity = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: 'clamp' });
  const subOpacity = interpolate(frame, [22, 45], [0, 1], { extrapolateRight: 'clamp' });
  const subY = interpolate(frame, [22, 45], [12, 0], { extrapolateRight: 'clamp' });
  const ruleW = interpolate(frame, [40, 70], [0, 140], { extrapolateRight: 'clamp' });
  const exit = interpolate(frame, [80, 90], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        opacity: exit,
      }}
    >
      <div
        style={{
          fontSize: 20,
          textTransform: 'uppercase',
          letterSpacing: '0.5em',
          color: C.inkDim,
          opacity: eyebrowOpacity,
          marginBottom: 40,
        }}
      >
        a demo
      </div>
      <div
        style={{
          opacity: wordmark,
          transform: `translateY(${interpolate(wordmark, [0, 1], [30, 0])}px)`,
          fontSize: 180,
          fontWeight: 700,
          letterSpacing: '-0.045em',
          color: C.ink,
          lineHeight: 1,
        }}
      >
        hisohiso
      </div>
      <div
        style={{
          marginTop: 36,
          opacity: subOpacity,
          transform: `translateY(${subY}px)`,
          fontSize: 38,
          color: C.inkSoft,
          letterSpacing: '-0.01em',
        }}
      >
        encrypted channel chat
      </div>
      <div style={{ marginTop: 60, width: ruleW, height: 3, backgroundColor: 'rgba(10,10,10,0.16)' }} />
    </AbsoluteFill>
  );
};
