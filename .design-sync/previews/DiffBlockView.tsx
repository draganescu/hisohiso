import { DiffBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const UnifiedDiff = () => (
  <div style={frame}>
    <DiffBlockView
      block={{
        type: 'diff',
        file: 'src/lib/room-session.ts',
        language: 'ts',
        stats: { additions: 3, deletions: 1 },
        hunks: [
          {
            header: '@@ -12,6 +12,8 @@ export function joinRoom(roomId: string)',
            lines: [
              { op: ' ', text: '  const session = await loadSession(roomId);' },
              { op: '-', text: '  if (!session) return null;' },
              { op: '+', text: '  if (!session) {' },
              { op: '+', text: '    log.warn("no session for room", roomId);' },
              { op: '+', text: '    return null;' },
              { op: ' ', text: '  }' },
              { op: ' ', text: '  return session;' },
            ],
          },
        ],
      }}
    />
  </div>
);

export const CommittedDiff = () => (
  <div style={frame}>
    <DiffBlockView
      block={{
        type: 'diff',
        file: 'app/src/components/Avatar.tsx',
        language: 'tsx',
        sha: 'a1b2c3d',
        stats: { additions: 1, deletions: 1 },
        hunks: [
          {
            header: '@@ -38,3 +38,3 @@ const Avatar = ({ seed, size }) =>',
            lines: [
              { op: ' ', text: '  className={' },
              { op: '-', text: "    'inline-flex items-center text-xs ' +" },
              { op: '+', text: "    'inline-flex items-center text-sm ' +" },
              { op: ' ', text: '    SIZE_CLASSES[size]' },
            ],
          },
        ],
      }}
    />
  </div>
);
