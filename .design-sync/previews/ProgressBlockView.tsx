import { ProgressBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const BuildInProgress = () => (
  <div style={frame}>
    <ProgressBlockView
      block={{
        type: 'progress',
        title: 'Shipping the auth refactor',
        steps: [
          { label: 'Read the existing session flow', status: 'done' },
          { label: 'Rewrite token validation', status: 'done' },
          { label: 'Run the test suite', status: 'active' },
          { label: 'Open the pull request', status: 'pending' },
        ],
      }}
    />
  </div>
);

export const FailedStep = () => (
  <div style={frame}>
    <ProgressBlockView
      block={{
        type: 'progress',
        title: 'Deploying to production',
        steps: [
          { label: 'Build the app bundle', status: 'done' },
          { label: 'Push image to registry', status: 'done' },
          { label: 'Health check on rollout', status: 'failed' },
          { label: 'Switch traffic to new pods', status: 'pending' },
        ],
      }}
    />
  </div>
);

export const AllDone = () => (
  <div style={frame}>
    <ProgressBlockView
      block={{
        type: 'progress',
        title: 'Migrated the encryption keys',
        steps: [
          { label: 'Back up the existing keystore', status: 'done' },
          { label: 'Re-encrypt with the new cipher', status: 'done' },
          { label: 'Verify round-trip on a sample', status: 'done' },
        ],
      }}
    />
  </div>
);
