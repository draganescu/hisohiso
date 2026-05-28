import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import { TerminalFrame, TermLine } from '../../components/TerminalFrame';
import { PhoneFrame } from '../../components/PhoneFrame';
import { JoinForm } from '../../pwa/JoinForm';
import { C } from '../../theme';

export const PhoneJoinsScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const termIn = spring({ frame, fps, config: { damping: 22, stiffness: 110 } });
  const phoneIn = spring({ frame: frame - 15, fps, config: { damping: 22, stiffness: 110 } });

  const cap = interpolate(frame, [10, 30], [0, 1], { extrapolateRight: 'clamp' });

  const pairText = '4429';
  const pairTyped = pairText.slice(0, Math.max(0, Math.min(pairText.length, Math.floor((frame - 50) / 5))));

  const noteText = 'andrei from terminal';
  const noteTyped = noteText.slice(0, Math.max(0, Math.min(noteText.length, Math.floor((frame - 95) / 3))));

  const knockSent = frame > 170;
  const connectedVisible = frame > 175;
  const listeningVisible = frame > 183;

  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          top: 60,
          width: '100%',
          textAlign: 'center',
          opacity: cap,
        }}
      >
        <div style={{ fontSize: 36, color: C.inkSoft, fontWeight: 500, letterSpacing: '-0.01em' }}>
          Phone scans, knocks
        </div>
        <div style={{ marginTop: 8, fontSize: 22, color: C.inkDim }}>
          CLI auto-approves when the secret matches
        </div>
      </div>

      {/* Terminal — upper area */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: 160,
          transform: `translateX(-50%) translateY(${interpolate(termIn, [0, 1], [40, 0])}px)`,
          opacity: termIn,
        }}
      >
        <TerminalFrame width={900} height={420} title="andrei@air — hisohiso wrap claude">
          <TermLine text="Pairing code: 4429" color="#fde68a" />
          <TermLine text="Waiting for phone to join..." color="#7dd3fc" />
          {connectedVisible && <div style={{ height: 12 }} />}
          {connectedVisible && <TermLine text="Phone connected." color="#86efac" />}
          {listeningVisible && <div style={{ height: 8 }} />}
          {listeningVisible && (
            <TermLine
              text="Listening (session). Messages from phone → claude <message>"
              dim
            />
          )}
        </TerminalFrame>
      </div>

      {/* Phone — lower area */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: -60,
          opacity: phoneIn,
          transform: `translateY(${interpolate(phoneIn, [0, 1], [60, 0])}px)`,
          height: 1400,
        }}
      >
        <PhoneFrame scale={0.62} translateY={0} time="9:42">
          <JoinForm roomKey={pairTyped} note={noteTyped} knockSent={knockSent} />
        </PhoneFrame>
      </div>
    </AbsoluteFill>
  );
};
