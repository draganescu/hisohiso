import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { IntroScene } from './scenes/IntroScene';
import { HomeScene } from './scenes/HomeScene';
import { CreateScene } from './scenes/CreateScene';
import { KnockScene } from './scenes/KnockScene';
import { ApproveScene } from './scenes/ApproveScene';
import { ChatScene } from './scenes/ChatScene';
import { ComposeScene } from './scenes/ComposeScene';
import { OutroScene } from './scenes/OutroScene';
import { FONT_SANS, C } from './theme';

export const FPS = 30;

const SCENES = [
  { Comp: IntroScene, frames: 90 },     // 3s
  { Comp: HomeScene, frames: 165 },     // 5.5s
  { Comp: CreateScene, frames: 165 },   // 5.5s
  { Comp: KnockScene, frames: 180 },    // 6s
  { Comp: ApproveScene, frames: 180 },  // 6s
  { Comp: ChatScene, frames: 270 },     // 9s
  { Comp: ComposeScene, frames: 210 },  // 7s — tap → modal → type → send
  { Comp: OutroScene, frames: 120 },    // 4s
];

export const DEMO_DURATION_FRAMES = SCENES.reduce((s, x) => s + x.frames, 0);

const offsets: number[] = [];
{
  let cursor = 0;
  for (const s of SCENES) {
    offsets.push(cursor);
    cursor += s.frames;
  }
}

export const HisohisoDemo = () => {
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
  return (
    <AbsoluteFill
      style={{ pointerEvents: 'none', backgroundColor: C.ink, opacity }}
    />
  );
};
