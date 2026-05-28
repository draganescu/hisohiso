import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import { C, FONT_MONO } from '../../theme';

const FEATURES = [
  'wrap any agent CLI',
  'session resume (claude, codex)',
  'daemon mode for many sessions',
  'all traffic E2E encrypted',
];

export const CliOutroScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const wordmark = spring({ frame, fps, config: { damping: 18, stiffness: 100 } });
  const cmdOpacity = interpolate(frame, [20, 50], [0, 1], { extrapolateRight: 'clamp' });
  const urlOpacity = interpolate(frame, [80, 110], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
      <div
        style={{
          opacity: wordmark,
          transform: `translateY(${interpolate(wordmark, [0, 1], [30, 0])}px)`,
          fontSize: 140,
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
          marginTop: 24,
          opacity: cmdOpacity,
          fontFamily: FONT_MONO,
          fontSize: 28,
          color: '#e7e7e7',
          backgroundColor: '#0d0d0d',
          padding: '14px 26px',
          borderRadius: 14,
        }}
      >
        $ hisohiso wrap claude
      </div>
      <div style={{ height: 60 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
        {FEATURES.map((f, i) => {
          const delay = 25 + i * 10;
          const op = interpolate(frame, [delay, delay + 20], [0, 1], { extrapolateRight: 'clamp' });
          const tx = interpolate(frame, [delay, delay + 20], [-12, 0], { extrapolateRight: 'clamp' });
          return (
            <div
              key={f}
              style={{
                opacity: op,
                transform: `translateX(${tx}px)`,
                fontSize: 30,
                color: C.inkSoft,
              }}
            >
              {f}
            </div>
          );
        })}
      </div>
      <div style={{ height: 70 }} />
      <div
        style={{
          opacity: urlOpacity,
          fontSize: 34,
          color: C.ink,
          fontWeight: 600,
          fontFamily: FONT_MONO,
          padding: '18px 32px',
          border: `2px solid ${C.rule}`,
          borderRadius: 18,
        }}
      >
        hisohiso.org
      </div>
    </AbsoluteFill>
  );
};
