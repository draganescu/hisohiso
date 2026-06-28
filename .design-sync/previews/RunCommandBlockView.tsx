import { RunCommandBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };
const noop = () => {};

export const SafeRun = () => (
  <div style={frame}>
    <RunCommandBlockView
      block={{
        type: 'run-command',
        id: 'run-tests',
        command: 'bun run test',
        description: 'Run the full test suite before I open the PR',
        risk: 'safe',
      }}
      onSelect={noop}
      submitted={false}
    />
  </div>
);

export const ModerateRun = () => (
  <div style={frame}>
    <RunCommandBlockView
      block={{
        type: 'run-command',
        id: 'install-deps',
        command: 'bun install --frozen-lockfile',
        description: 'Reinstall dependencies to match the lockfile',
        risk: 'moderate',
      }}
      onSelect={noop}
      submitted={false}
    />
  </div>
);

export const DangerousRun = () => (
  <div style={frame}>
    <RunCommandBlockView
      block={{
        type: 'run-command',
        id: 'reset-db',
        command: 'git push --force-with-lease origin main',
        description: 'Force-push the rebased history (hold to confirm)',
        risk: 'dangerous',
      }}
      onSelect={noop}
      submitted={false}
    />
  </div>
);
