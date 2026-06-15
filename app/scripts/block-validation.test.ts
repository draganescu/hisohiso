import { sanitizeBlocksForRender } from '../src/lib/block-validation.js';

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const blocks = sanitizeBlocksForRender([
  { type: 'file-tree', title: 'Important files', files: ['README.md', 'src/index.ts'] },
  { type: 'terminal', title: 'Verification', content: 'PHP lint OK' },
  { type: 'code', title: 'Snapshot', content: 'hello' },
  { type: 'progress', title: 'Done', steps: [{ label: 'Investigate', status: 'done' }] },
  { type: 'diff', file: 'a.ts', hunks: [], committed_sha: { nope: true }, sha: 'abc1234567890' },
  null,
  { nope: true },
]);

assert(blocks.length === 5, `expected 5 renderable blocks, got ${blocks.length}`);

const fileTree = blocks[0] as unknown as Record<string, unknown>;
assert(fileTree.type === 'error', 'malformed file-tree should become an error block');
assert(String(fileTree.title).includes('Invalid file-tree block'), 'file-tree error title should describe invalid block');

const terminal = blocks[1] as unknown as Record<string, unknown>;
assert(terminal.type === 'error', 'malformed terminal should become an error block');
assert(String(terminal.title).includes('Invalid terminal block'), 'terminal error title should describe invalid block');

assert(blocks[2]?.type === 'code', 'valid code block should be preserved');
assert(blocks[3]?.type === 'progress', 'valid progress block should be preserved');

const diff = blocks[4] as unknown as Record<string, unknown>;
assert(diff.type === 'diff', 'valid diff block should be preserved');
assert(diff.sha === 'abc1234567890', 'valid diff sha should be preserved');
assert(diff.committed_sha === undefined, 'non-string committed_sha should be stripped');

console.log('block validation regression OK');
