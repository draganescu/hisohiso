import { FilePeekBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const TypeScriptSlice = () => (
  <div style={frame}>
    <FilePeekBlockView
      block={{
        type: 'file-peek',
        file: 'src/lib/room-session.ts',
        language: 'ts',
        start_line: 42,
        total_lines: 188,
        content: [
          'export async function joinRoom(roomId: string) {',
          '  const session = await loadSession(roomId);',
          '  if (!session) {',
          '    log.warn("no session for room", roomId);',
          '    return null;',
          '  }',
          '  return session;',
          '}',
        ].join('\n'),
      }}
    />
  </div>
);

export const ConfigSlice = () => (
  <div style={frame}>
    <FilePeekBlockView
      block={{
        type: 'file-peek',
        file: 'app/tailwind.ds.config.js',
        language: 'js',
        start_line: 8,
        total_lines: 64,
        content: [
          '    colors: {',
          '      ink: "#1b1b1b",',
          '      "ink-dim": "#6b6b6b",',
          '      rule: "#e6e3dc",',
          '      surface: "#fbfaf7",',
          '    },',
        ].join('\n'),
      }}
    />
  </div>
);
