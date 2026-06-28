import { ChecklistBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };
const noop = () => {};

export const PreReleaseChecklist = () => (
  <div style={frame}>
    <ChecklistBlockView
      block={{
        type: 'checklist',
        id: 'pre-release',
        prompt: 'Before I cut CLI v0.13.0, which steps should I run?',
        confirm_label: 'Run selected',
        items: [
          { value: 'tests', label: 'Run the full test suite', checked: true },
          { value: 'build', label: 'Rebuild the app bundle', checked: true },
          { value: 'changelog', label: 'Update the changelog' },
          { value: 'tag', label: 'Tag and push the release' },
        ],
      }}
      onSelect={noop}
      submitted={false}
    />
  </div>
);

export const DeployGate = () => (
  <div style={frame}>
    <ChecklistBlockView
      block={{
        type: 'checklist',
        id: 'deploy-gate',
        prompt: 'Confirm the deploy preconditions for production:',
        items: [
          { value: 'green', label: 'CI is green on main', checked: true },
          { value: 'migrations', label: 'DB migrations reviewed' },
          { value: 'rollback', label: 'Rollback plan is documented' },
        ],
      }}
      onSelect={noop}
      submitted={false}
    />
  </div>
);
