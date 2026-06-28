import { FileTreeBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const ChangedFiles = () => (
  <div style={frame}>
    <FileTreeBlockView
      block={{
        type: 'file-tree',
        summary: '6 files changed',
        nodes: [
          {
            path: 'src',
            children: [
              {
                path: 'lib',
                children: [
                  { path: 'room-session.ts', status: 'modified' },
                  { path: 'presence.ts', status: 'modified' },
                ],
              },
              {
                path: 'components',
                children: [
                  { path: 'Avatar.tsx', status: 'modified' },
                  { path: 'PresenceDot.tsx', status: 'added' },
                ],
              },
            ],
          },
          {
            path: 'tests',
            children: [
              { path: 'presence.test.ts', status: 'added' },
              { path: 'legacy-poll.test.ts', status: 'deleted' },
            ],
          },
        ],
      }}
    />
  </div>
);

export const SmallRename = () => (
  <div style={frame}>
    <FileTreeBlockView
      block={{
        type: 'file-tree',
        summary: '2 files changed',
        nodes: [
          {
            path: 'app/src/components/blocks',
            children: [
              { path: 'LinkCard.tsx', status: 'renamed' },
              { path: 'LinkPreviewBlock.tsx', status: 'modified' },
            ],
          },
        ],
      }}
    />
  </div>
);
