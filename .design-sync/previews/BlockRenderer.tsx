import { BlockRenderer } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };
const noop = () => {};

export const AgentTurn = () => (
  <div style={frame}>
    <BlockRenderer
      onRespond={noop}
      blocks={[
        {
          type: 'prose',
          id: 'p1',
          content:
            "I found the cause of the flaky test — a race in the presence poller. Here's the fix:",
        },
        {
          type: 'diff',
          id: 'd1',
          file: 'src/lib/presence.ts',
          stats: { additions: 2, deletions: 2 },
          hunks: [
            {
              header: '@@ -40,4 +40,4 @@',
              lines: [
                { op: '-', text: '  clearInterval(timer);' },
                { op: '-', text: '  timer = setInterval(poll, 1000);' },
                { op: '+', text: '  if (timer) clearInterval(timer);' },
                { op: '+', text: '  timer = setInterval(poll, POLL_MS);' },
              ],
            },
          ],
        },
        {
          type: 'buttons',
          id: 'b1',
          prompt: 'Want me to apply it and re-run the test?',
          options: [
            { label: 'Apply & run', value: 'yes' },
            { label: 'Just apply', value: 'apply' },
            { label: 'Hold on', value: 'wait' },
          ],
        },
      ]}
    />
  </div>
);

export const ProgressThread = () => (
  <div style={frame}>
    <BlockRenderer
      onRespond={noop}
      blocks={[
        {
          type: 'thinking',
          id: 't1',
          content: 'Checking the failing assertion and the surrounding test setup…',
        },
        {
          type: 'progress',
          id: 'pr1',
          title: 'Fixing the flaky test',
          steps: [
            { label: 'Reproduce locally', status: 'done' },
            { label: 'Patch the presence poller', status: 'active' },
            { label: 'Re-run 50× to confirm', status: 'pending' },
          ],
        },
      ]}
    />
  </div>
);
