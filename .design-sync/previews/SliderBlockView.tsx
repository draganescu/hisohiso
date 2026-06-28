import { SliderBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };
const noop = () => {};

export const RefactorAggression = () => (
  <div style={frame}>
    <SliderBlockView
      block={{
        type: 'slider',
        id: 'refactor-scope',
        prompt: 'How aggressive should the refactor be?',
        min: { value: 0, label: 'Minimal' },
        max: { value: 10, label: 'Rewrite' },
        default: 4,
      }}
      onSelect={noop}
      submitted={false}
    />
  </div>
);

export const TestCoverage = () => (
  <div style={frame}>
    <SliderBlockView
      block={{
        type: 'slider',
        id: 'coverage-target',
        prompt: 'What coverage target should I aim for?',
        min: { value: 50, label: '50%' },
        max: { value: 100, label: '100%' },
        default: 85,
        steps: 10,
      }}
      onSelect={noop}
      submitted={false}
    />
  </div>
);

export const Verbosity = () => (
  <div style={frame}>
    <SliderBlockView
      block={{
        type: 'slider',
        id: 'log-verbosity',
        prompt: 'How chatty should the commit messages be?',
        min: { value: 1, label: 'Terse' },
        max: { value: 5, label: 'Detailed' },
        default: 3,
      }}
      onSelect={noop}
      submitted={false}
    />
  </div>
);
