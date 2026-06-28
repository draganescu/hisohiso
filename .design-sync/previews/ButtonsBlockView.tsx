import { ButtonsBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const SingleChoice = () => (
  <div style={frame}>
    <ButtonsBlockView
      block={{
        type: 'buttons',
        id: 'merge-strategy',
        prompt: 'How should I land this branch?',
        options: [
          { label: 'Rebase', value: 'rebase' },
          { label: 'Merge commit', value: 'merge' },
          { label: 'Squash', value: 'squash' },
        ],
      }}
      submitted={false}
    />
  </div>
);

export const MultiSelect = () => (
  <div style={frame}>
    <ButtonsBlockView
      block={{
        type: 'buttons',
        id: 'stage-files',
        prompt: 'Which files should I stage for the commit?',
        multi: true,
        options: [
          { label: 'src/auth.ts', value: 'auth' },
          { label: 'src/db.ts', value: 'db' },
          { label: 'tests/auth.test.ts', value: 'test' },
        ],
      }}
      submitted={false}
    />
  </div>
);

export const Stacked = () => (
  <div style={frame}>
    <ButtonsBlockView
      block={{
        type: 'buttons',
        id: 'deploy-env',
        prompt: 'Deploy to which environment?',
        style: 'stacked',
        options: [
          { label: 'Production', value: 'prod' },
          { label: 'Staging', value: 'staging' },
          { label: 'Preview', value: 'preview' },
        ],
      }}
      submitted={false}
    />
  </div>
);
