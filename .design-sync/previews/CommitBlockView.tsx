import { CommitBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };
const noop = () => {};

export const ReviewCommit = () => (
  <div style={frame}>
    <CommitBlockView
      block={{
        type: 'commit',
        id: 'commit-presence-fix',
        message: `Fix flaky presence poller test

Guard against a double-scheduled interval that raced the
presence assertion. Re-ran 50x locally with no failures.`,
        files: ['src/lib/presence.ts', 'tests/presence.test.ts'],
        stats: { additions: 7, deletions: 4 },
      }}
      onSelect={noop}
      submitted={false}
    />
  </div>
);

export const SubjectOnly = () => (
  <div style={frame}>
    <CommitBlockView
      block={{
        type: 'commit',
        id: 'commit-rail-fix',
        message: 'Desktop rail channel switch no longer submits open draft',
        files: ['app/src/components/Rail.tsx'],
        stats: { additions: 18, deletions: 5 },
      }}
      onSelect={noop}
      submitted={false}
    />
  </div>
);
