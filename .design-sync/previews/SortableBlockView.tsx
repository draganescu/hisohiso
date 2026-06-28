import { SortableBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };
const noop = () => {};

export const BugPriorities = () => (
  <div style={frame}>
    <SortableBlockView
      block={{
        type: 'sortable',
        id: 'triage-order',
        prompt: 'Drag to set the order I should fix these in',
        items: [
          { value: 'crash', label: 'Crash on cold start' },
          { value: 'leak', label: 'Memory leak in the poller' },
          { value: 'typo', label: 'Typo in the settings label' },
          { value: 'slow', label: 'Slow room switch on large lists' },
        ],
        confirm_label: 'Use this order',
      }}
      onSelect={noop}
      submitted={false}
    />
  </div>
);

export const ReleaseSteps = () => (
  <div style={frame}>
    <SortableBlockView
      block={{
        type: 'sortable',
        id: 'release-order',
        prompt: 'Arrange the release steps in the order to run them',
        items: [
          { value: 'tag', label: 'Tag the release' },
          { value: 'build', label: 'Build the bundle' },
          { value: 'changelog', label: 'Write the changelog' },
          { value: 'deploy', label: 'Push to deploy' },
        ],
      }}
      onSelect={noop}
      submitted={false}
    />
  </div>
);
