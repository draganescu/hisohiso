import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { CliIntroScene } from './scenes/cli/CliIntroScene';
import { InstallScene } from './scenes/cli/InstallScene';
import { WrapPromptScene } from './scenes/cli/WrapPromptScene';
import { QrPairingScene } from './scenes/cli/QrPairingScene';
import { PhoneJoinsScene } from './scenes/cli/PhoneJoinsScene';
import { BridgeRoundtripScene } from './scenes/cli/BridgeRoundtripScene';
import { CliOutroScene } from './scenes/cli/CliOutroScene';
import { FONT_SANS, C } from './theme';

const SCENES = [
  { Comp: CliIntroScene, frames: 90 },          // 3s
  { Comp: InstallScene, frames: 165 },          // 5.5s
  { Comp: WrapPromptScene, frames: 180 },       // 6s
  { Comp: QrPairingScene, frames: 180 },        // 6s
  { Comp: PhoneJoinsScene, frames: 210 },       // 7s
  { Comp: BridgeRoundtripScene, frames: 510 },  // 17s — two turns inc. session resume
  { Comp: CliOutroScene, frames: 135 },         // 4.5s
];

export const CLI_DEMO_DURATION_FRAMES = SCENES.reduce((s, x) => s + x.frames, 0);

const offsets: number[] = [];
{
  let cursor = 0;
  for (const s of SCENES) {
    offsets.push(cursor);
    cursor += s.frames;
  }
}

export const CliDemo = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, fontFamily: FONT_SANS }}>
      {SCENES.map((s, i) => {
        const Comp = s.Comp;
        return (
          <Sequence key={i} from={offsets[i]} durationInFrames={s.frames}>
            <Comp />
          </Sequence>
        );
      })}
      <FadeInOut />
    </AbsoluteFill>
  );
};

const FadeInOut = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fadeIn = interpolate(frame, [0, 18], [1, 0], { extrapolateRight: 'clamp' });
  const fadeOut = interpolate(frame, [durationInFrames - 22, durationInFrames - 1], [0, 1], {
    extrapolateLeft: 'clamp',
  });
  const opacity = Math.max(fadeIn, fadeOut);
  return <AbsoluteFill style={{ pointerEvents: 'none', backgroundColor: C.ink, opacity }} />;
};
