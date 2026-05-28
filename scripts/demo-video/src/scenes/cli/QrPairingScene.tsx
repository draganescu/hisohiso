import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import { TerminalFrame, TermLine } from '../../components/TerminalFrame';
import { QrAscii } from '../../components/QrAscii';
import { C } from '../../theme';

export const QrPairingScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const termIn = spring({ frame, fps, config: { damping: 22, stiffness: 110 } });
  const cap = interpolate(frame, [10, 30], [0, 1], { extrapolateRight: 'clamp' });

  // Output reveals top→bottom over the scene
  const lineVisible = (delay: number) => frame > delay;

  // Waiting dots cycle
  const dotCount = Math.floor(frame / 8) % 4;
  const waitingDots = '.'.repeat(dotCount);

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
      <div
        style={{
          opacity: cap,
          fontSize: 36,
          color: C.inkSoft,
          fontWeight: 500,
          letterSpacing: '-0.01em',
          marginBottom: 12,
        }}
      >
        QR + pairing code
      </div>
      <div
        style={{
          opacity: cap,
          fontSize: 22,
          color: C.inkDim,
          marginBottom: 32,
        }}
      >
        scan from your phone — knock secret never appears here
      </div>

      <div
        style={{
          opacity: termIn,
          transform: `translateY(${interpolate(termIn, [0, 1], [40, 0])}px)`,
        }}
      >
        <TerminalFrame width={960} height={1180} title="andrei@air — hisohiso wrap claude">
          {lineVisible(20) && <TermLine text="Scan to connect (claude):" />}
          {lineVisible(28) && <div style={{ height: 10 }} />}
          {lineVisible(28) && (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <QrAscii fontSize={22} color="#e7e7e7" />
            </div>
          )}
          {lineVisible(60) && <div style={{ height: 14 }} />}
          {lineVisible(60) && (
            <TermLine text="Or open: https://hisohiso.org/room#k9X2pQ7vN4mLz8…" />
          )}
          {lineVisible(75) && (
            <TermLine text="Pairing code: 4429" color="#fde68a" />
          )}
          {lineVisible(90) && (
            <TermLine
              text="(Enter the pairing code as the room password;"
              dim
            />
          )}
          {lineVisible(90) && (
            <TermLine text=" use your knock message as the knock body.)" dim />
          )}
          {lineVisible(108) && <div style={{ height: 10 }} />}
          {lineVisible(108) && (
            <TermLine text={`Waiting for phone to join${waitingDots}`} color="#7dd3fc" />
          )}
        </TerminalFrame>
      </div>
    </AbsoluteFill>
  );
};
