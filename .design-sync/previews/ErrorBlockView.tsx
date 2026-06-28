import { ErrorBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const TypeError = () => (
  <div style={frame}>
    <ErrorBlockView
      block={{
        type: 'error',
        title: "TypeError: Cannot read properties of undefined (reading 'id')",
        file: 'src/lib/room-session.ts',
        line: 47,
        stack: [
          "    at joinRoom (src/lib/room-session.ts:47:18)",
          "    at handleKnock (src/lib/relay.ts:212:24)",
          "    at WebSocket.<anonymous> (src/server/ws.ts:88:9)",
          "    at WebSocket.emit (node:events:518:28)",
        ].join('\n'),
        suggestion:
          'session can be null when the room was reaped between knock and join. Guard with `if (!session) return;` before reading session.id.',
      }}
    />
  </div>
);

export const TestFailure = () => (
  <div style={frame}>
    <ErrorBlockView
      block={{
        type: 'error',
        title: 'AssertionError: expected presence count 1 to equal 2',
        file: 'tests/presence.test.ts',
        line: 31,
        stack: [
          "    at Object.<anonymous> (tests/presence.test.ts:31:25)",
          "    at Promise.then.completed (node_modules/bun/test.ts:316:14)",
        ].join('\n'),
        suggestion:
          'The poller fires before the second client finishes the handshake. Await `room.ready()` in the test setup, or raise the flush timeout.',
      }}
    />
  </div>
);

export const TerseError = () => (
  <div style={frame}>
    <ErrorBlockView
      block={{
        type: 'error',
        title: 'Build failed: tailwind class `bg-rule` not found',
        file: 'app/src/components/blocks/LabelBlock.tsx',
        line: 12,
        suggestion: '`rule` is not in the theme. Did you mean the `border-rule` utility?',
      }}
    />
  </div>
);
