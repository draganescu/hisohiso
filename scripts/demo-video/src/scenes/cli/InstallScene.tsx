import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import { TerminalFrame, TermLine, sliceText } from '../../components/TerminalFrame';
import { C } from '../../theme';

const PROMPT = '$';

export const InstallScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const termIn = spring({ frame, fps, config: { damping: 22, stiffness: 110 } });

  const cap = interpolate(frame, [10, 30], [0, 1], { extrapolateRight: 'clamp' });

  // Stage 1: type the install command (chars 0..N over frames 30..80)
  const installCmd = 'curl -fsSL https://hisohiso.org/install.sh | sh';
  const stage1Start = 30;
  const stage1Chars = Math.floor((frame - stage1Start) / 1.4);
  const installRevealed = sliceText(installCmd, stage1Chars);
  const stage1Caret = (Math.floor(frame / 14) % 2 === 0) && frame > stage1Start && frame < 80;

  // Stage 2: output lines after frame ~85
  const out1Visible = frame > 80;
  const out2Visible = frame > 90;
  const out3Visible = frame > 100;

  // Stage 3: blank line then version check
  const checkStart = 115;
  const checkCmd = 'hisohiso --version';
  const checkRev = sliceText(checkCmd, Math.floor((frame - checkStart) / 1.4));
  const checkCaret = (Math.floor(frame / 14) % 2 === 0) && frame > checkStart && frame < 140;

  // Stage 4: version output
  const versionVisible = frame > 142;

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
        One line to install
      </div>
      <div
        style={{
          opacity: cap,
          fontSize: 22,
          color: C.inkDim,
          marginBottom: 40,
        }}
      >
        macOS / Linux · pre-built binaries on GitHub Releases
      </div>

      <div
        style={{
          opacity: termIn,
          transform: `translateY(${interpolate(termIn, [0, 1], [40, 0])}px)`,
        }}
      >
        <TerminalFrame width={920} height={620} title="andrei@air — ~">
          <TermLine prompt={PROMPT} text={installRevealed} caret={stage1Caret} />
          <div style={{ height: 6 }} />
          {out1Visible && (
            <TermLine text="==> Downloading hisohiso 0.4.17 for darwin-arm64..." dim />
          )}
          {out2Visible && (
            <TermLine text="==> Installed to ~/.local/bin/hisohiso" dim />
          )}
          {out3Visible && (
            <TermLine text="==> Make sure ~/.local/bin is on your PATH." dim />
          )}
          {(out1Visible || frame > stage1Start + 30) && <div style={{ height: 18 }} />}
          {frame > checkStart - 4 && (
            <TermLine prompt={PROMPT} text={checkRev} caret={checkCaret && !versionVisible} />
          )}
          {versionVisible && <TermLine text="hisohiso 0.4.17" color="#86efac" />}
        </TerminalFrame>
      </div>
    </AbsoluteFill>
  );
};
