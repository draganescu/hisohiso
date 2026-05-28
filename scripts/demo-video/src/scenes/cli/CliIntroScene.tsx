import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import { C, FONT_MONO } from '../../theme';

export const CliIntroScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const wordmark = spring({ frame, fps, config: { damping: 18, stiffness: 90 } });
  const promptOpacity = interpolate(frame, [22, 50], [0, 1], { extrapolateRight: 'clamp' });
  const subOpacity = interpolate(frame, [38, 65], [0, 1], { extrapolateRight: 'clamp' });
  const ruleW = interpolate(frame, [55, 80], [0, 160], { extrapolateRight: 'clamp' });
  const exit = interpolate(frame, [80, 90], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', opacity: exit }}
    >
      <div
        style={{
          fontSize: 20,
          textTransform: 'uppercase',
          letterSpacing: '0.5em',
          color: C.inkDim,
          opacity: promptOpacity,
          marginBottom: 32,
        }}
      >
        from your laptop
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
          marginTop: 28,
          opacity: subOpacity,
          fontFamily: FONT_MONO,
          fontSize: 32,
          color: C.ink,
          letterSpacing: '-0.01em',
          padding: '12px 24px',
          backgroundColor: '#0d0d0d',
          color: '#e7e7e7',
          borderRadius: 12,
        }}
      >
        $ hisohiso wrap claude
      </div>
      <div style={{ marginTop: 36, width: ruleW, height: 3, backgroundColor: 'rgba(10,10,10,0.16)' }} />
      <div
        style={{
          marginTop: 32,
          opacity: subOpacity,
          fontSize: 28,
          color: C.inkSoft,
        }}
      >
        bridge your terminal AI agent to your phone
      </div>
    </AbsoluteFill>
  );
};
