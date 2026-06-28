import { ConfirmDangerBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };
const noop = () => {};

export const ForcePush = () => (
  <div style={frame}>
    <ConfirmDangerBlockView
      block={{
        type: 'confirm-danger',
        id: 'force-push',
        title: 'Force-push to main',
        description:
          'This rewrites the remote history on main and ruleset bypass is active. Anyone who pulled the old commits will need to reset.',
        command: 'git push --force-with-lease origin main',
        confirm_label: 'Force-push',
        cancel_label: 'Cancel',
      }}
      onSelect={noop}
      submitted={false}
    />
  </div>
);

export const DropDatabase = () => (
  <div style={frame}>
    <ConfirmDangerBlockView
      block={{
        type: 'confirm-danger',
        id: 'reset-rooms',
        title: 'Reset the rooms table',
        description:
          'Drops every row in the production rooms table. All paired devices will be logged out and must re-pair from scratch.',
        command: 'TRUNCATE TABLE rooms CASCADE;',
        confirm_label: 'Reset rooms',
        cancel_label: 'Keep data',
      }}
      onSelect={noop}
      submitted={false}
    />
  </div>
);
