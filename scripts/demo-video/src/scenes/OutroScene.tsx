import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import { C, FONT_MONO } from '../theme';

const FEATURES = [
  'no accounts',
  'no cloud history',
  'no tracking',
  'installable PWA',
];

export const OutroScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const wordmark = spring({ frame, fps, config: { damping: 18, stiffness: 100 } });
  const urlOpacity = interpolate(frame, [70, 100], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
      <div
        style={{
          opacity: wordmark,
          transform: `translateY(${interpolate(wordmark, [0, 1], [30, 0])}px)`,
          fontSize: 150,
          fontWeight: 700,
          letterSpacing: '-0.045em',
          color: C.ink,
          lineHeight: 1,
        }}
      >
        hisohiso
      </div>
      <div style={{ height: 56 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
        {FEATURES.map((f, i) => {
          const delay = 15 + i * 10;
          const op = interpolate(frame, [delay, delay + 20], [0, 1], { extrapolateRight: 'clamp' });
          const tx = interpolate(frame, [delay, delay + 20], [-12, 0], { extrapolateRight: 'clamp' });
          return (
            <div
              key={f}
              style={{
                opacity: op,
                transform: `translateX(${tx}px)`,
                fontSize: 34,
                color: C.inkSoft,
                fontWeight: 400,
              }}
            >
              {f}
            </div>
          );
        })}
      </div>
      <div style={{ height: 90 }} />
      <div
        style={{
          opacity: urlOpacity,
          fontSize: 36,
          color: C.ink,
          fontWeight: 600,
          fontFamily: FONT_MONO,
          padding: '20px 36px',
          border: `2px solid ${C.rule}`,
          borderRadius: 20,
          letterSpacing: '0.01em',
        }}
      >
        hisohiso.org
      </div>
    </AbsoluteFill>
  );
};
