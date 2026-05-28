import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import { TerminalFrame, TermLine, sliceText } from '../../components/TerminalFrame';
import { C } from '../../theme';

const PROMPT = '$';

export const WrapPromptScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const termIn = spring({ frame, fps, config: { damping: 22, stiffness: 110 } });
  const cap = interpolate(frame, [10, 30], [0, 1], { extrapolateRight: 'clamp' });

  // Stage 1: type wrap command
  const cmd = 'hisohiso wrap claude';
  const cmdStart = 30;
  const cmdRev = sliceText(cmd, Math.floor((frame - cmdStart) / 1.6));
  const cmdCaret = (Math.floor(frame / 14) % 2 === 0) && frame > cmdStart && frame < 70;

  // Stage 2: knock prompt label appears
  const promptVisible = frame > 72;

  // Stage 3: type the hidden secret (show bullets)
  const secretStart = 88;
  const bullets = Math.min(12, Math.max(0, Math.floor((frame - secretStart) / 4)));
  const bulletStr = '•'.repeat(bullets);
  const secretCaret = (Math.floor(frame / 14) % 2 === 0) && frame > secretStart && frame < 140;

  // Stage 4: enter pressed, acknowledgement
  const ackVisible = frame > 145;

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
        Wrap an agent
      </div>
      <div
        style={{
          opacity: cap,
          fontSize: 22,
          color: C.inkDim,
          marginBottom: 40,
        }}
      >
        opens a one-off encrypted channel that bridges to Claude
      </div>

      <div
        style={{
          opacity: termIn,
          transform: `translateY(${interpolate(termIn, [0, 1], [40, 0])}px)`,
        }}
      >
        <TerminalFrame width={920} height={620} title="andrei@air — hisohiso">
          <TermLine prompt={PROMPT} text={cmdRev} caret={cmdCaret && !promptVisible} />
          <div style={{ height: 10 }} />
          {promptVisible && (
            <>
              <TermLine
                text="Knock message (the secret the phone will type as the knock body):"
                dim
              />
              <TermLine text={bulletStr} caret={secretCaret && !ackVisible} />
            </>
          )}
          {ackVisible && (
            <>
              <div style={{ height: 14 }} />
              <TermLine text="(secret stored only in this process — never written to disk)" dim />
            </>
          )}
        </TerminalFrame>
      </div>
    </AbsoluteFill>
  );
};
