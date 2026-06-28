import { ProseBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const Explanation = () => (
  <div style={frame}>
    <ProseBlockView
      block={{
        type: 'prose',
        content: [
          '## What was causing the flake',
          '',
          'The presence poller created a **new interval** on every reconnect without clearing the old one, so two timers raced to write the same state.',
          '',
          'The fix guards the timer with `if (timer) clearInterval(timer)` before redialing, and reads the cadence from `POLL_MS` instead of a hard-coded `1000`.',
        ].join('\n'),
      }}
    />
  </div>
);

export const Summary = () => (
  <div style={frame}>
    <ProseBlockView
      block={{
        type: 'prose',
        content: [
          '# Review summary',
          '',
          'The branch is in good shape. A few things worth a second look:',
          '',
          '- The retry loop has *no upper bound* — add a cap',
          '- `loadSession` swallows errors silently',
          '- Tests cover the happy path but **not** the timeout case',
          '',
          'Nothing blocking. I can address all three in a follow-up.',
        ].join('\n'),
      }}
    />
  </div>
);

export const ShortNote = () => (
  <div style={frame}>
    <ProseBlockView
      block={{
        type: 'prose',
        content:
          'I rebased onto `main` and the conflict in `room-session.ts` resolved cleanly — only the import order differed. Re-running the suite now.',
      }}
    />
  </div>
);
