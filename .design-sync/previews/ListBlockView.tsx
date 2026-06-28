import { ListBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const ReleaseChecklist = () => (
  <div style={frame}>
    <ListBlockView
      block={{
        type: 'list',
        title: 'Before I cut the release',
        style: 'check',
        items: [
          'All tests green on CI',
          'CHANGELOG updated to v0.13.0',
          'Version bumped in package.json',
          'Migration notes added to the PR',
        ],
      }}
    />
  </div>
);

export const NumberedSteps = () => (
  <div style={frame}>
    <ListBlockView
      block={{
        type: 'list',
        title: 'How the daemon reconnects',
        style: 'numbered',
        items: [
          'Detect the dropped relay socket',
          'Back off with jitter, then redial',
          'Replay any queued outbound messages',
          'Resume the presence heartbeat',
        ],
      }}
    />
  </div>
);

export const FilesTouched = () => (
  <div style={frame}>
    <ListBlockView
      block={{
        type: 'list',
        style: 'bullet',
        items: [
          'src/lib/room-session.ts',
          'src/lib/presence.ts',
          'app/src/components/RoomsRail.tsx',
          'tests/room-session.test.ts',
        ],
      }}
    />
  </div>
);
