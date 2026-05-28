import { Composition } from 'remotion';
import { HisohisoDemo, DEMO_DURATION_FRAMES } from './HisohisoDemo';
import { CliDemo, CLI_DEMO_DURATION_FRAMES } from './CliDemo';

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="HisohisoDemo"
        component={HisohisoDemo}
        durationInFrames={DEMO_DURATION_FRAMES}
        fps={30}
        width={1080}
        height={1920}
      />
      <Composition
        id="CliDemo"
        component={CliDemo}
        durationInFrames={CLI_DEMO_DURATION_FRAMES}
        fps={30}
        width={1080}
        height={1920}
      />
    </>
  );
};
