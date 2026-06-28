import { LinkPreviewBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const PullRequest = () => (
  <div style={frame}>
    <LinkPreviewBlockView
      block={{
        type: 'link-preview',
        url: 'https://github.com/draganescu/hisohiso/pull/224',
        domain: 'github.com',
        title: 'Fix presence poller race on room rejoin #224',
        description:
          'Guards joinRoom against a reaped session and de-flakes the presence test by awaiting the handshake. +18 -9 across 6 files.',
      }}
    />
  </div>
);

export const Docs = () => (
  <div style={frame}>
    <LinkPreviewBlockView
      block={{
        type: 'link-preview',
        url: 'https://bun.sh/docs/cli/test',
        domain: 'bun.sh',
        title: 'bun test – Bun Documentation',
        description:
          'Run your tests with the fast, built-in test runner. Covers timeouts, lifecycle hooks, and watch mode.',
      }}
    />
  </div>
);

export const FailedRun = () => (
  <div style={frame}>
    <LinkPreviewBlockView
      block={{
        type: 'link-preview',
        url: 'https://github.com/draganescu/hisohiso/actions/runs/918273645',
        domain: 'github.com',
        title: 'CI / build-and-deploy — failed',
        description:
          'Job "test" failed at step "bun test": 1 failing in tests/presence.test.ts. Re-run after the poller fix lands.',
      }}
    />
  </div>
);
