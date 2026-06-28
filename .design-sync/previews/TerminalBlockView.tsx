import { TerminalBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const TestsPassing = () => (
  <div style={frame}>
    <TerminalBlockView
      block={{
        type: 'terminal',
        command: 'bun test src/lib/room-session.test.ts',
        output: [
          'bun test v1.1.30',
          '',
          'src/lib/room-session.test.ts:',
          '  ✓ joins an existing room (12ms)',
          '  ✓ rejects an unknown room id (3ms)',
          '  ✓ resumes after a dropped socket (28ms)',
          '',
          ' 3 pass',
          ' 0 fail',
          ' 7 expect() calls',
          'Ran 3 tests across 1 file. [184ms]',
        ].join('\n'),
        exit_code: 0,
      }}
    />
  </div>
);

export const TypecheckFailing = () => (
  <div style={frame}>
    <TerminalBlockView
      block={{
        type: 'terminal',
        command: 'npx tsc --noEmit',
        output: [
          'src/lib/presence.ts:42:18 - error TS2532: Object is possibly \'undefined\'.',
          '',
          '42   timer = setInterval(poll, opts.intervalMs);',
          '                      ~~~~~~~~~~~~~~~~',
          '',
          'Found 1 error in src/lib/presence.ts:42',
        ].join('\n'),
        exit_code: 2,
      }}
    />
  </div>
);

export const GitStatus = () => (
  <div style={frame}>
    <TerminalBlockView
      block={{
        type: 'terminal',
        command: 'git status --short',
        output: [
          ' M app/src/lib/presence.ts',
          ' M app/src/lib/room-session.ts',
          '?? app/src/lib/room-session.test.ts',
        ].join('\n'),
        exit_code: 0,
      }}
    />
  </div>
);
