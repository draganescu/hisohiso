import { CodeBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const FileSnippet = () => (
  <div style={frame}>
    <CodeBlockView
      block={{
        type: 'code',
        file: 'src/lib/room-session.ts',
        language: 'ts',
        start_line: 12,
        highlight_lines: [14, 15],
        content: `export async function joinRoom(roomId: string) {
  const session = await loadSession(roomId);
  if (!session) {
    log.warn('no session for room', roomId);
    return null;
  }
  return session;
}`,
      }}
    />
  </div>
);

export const ShellSnippet = () => (
  <div style={frame}>
    <CodeBlockView
      block={{
        type: 'code',
        language: 'bash',
        content: `bun run build
git add app/dist
git commit -m "Rebuild app bundle"
git push origin main`,
      }}
    />
  </div>
);
