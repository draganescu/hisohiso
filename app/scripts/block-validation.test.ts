import { sanitizeBlocksForRender } from '../src/lib/block-validation.js';
import { redactSecretsForStorage, SECRET_VALUE_MASK } from '../src/lib/room-message.js';

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const blocks = sanitizeBlocksForRender([
  { type: 'file-tree', title: 'Important files', files: ['README.md', 'src/index.ts'] },
  { type: 'terminal', title: 'Verification', content: 'PHP lint OK' },
  { type: 'code', title: 'Snapshot', content: 'hello' },
  { type: 'progress', title: 'Done', steps: [{ label: 'Investigate', status: 'done' }] },
  { type: 'diff', file: 'a.ts', hunks: [], committed_sha: { nope: true }, sha: 'abc1234567890' },
  {
    type: 'swatches',
    title: 'Palette',
    schemes: [
      {
        name: 'Dusty Pop',
        colors: [
          { hex: '#E0728F', name: 'pink' },
          { hex: 'red' },
          { hex: '#abc' },
          { hex: 'javascript:alert(1)' },
        ],
      },
      { name: 'all bad', colors: [{ hex: 'rgb(1,2,3)' }] },
    ],
  },
  { type: 'secret', id: 's1', prompt: 'Paste token', placeholder: 'ghp_' },
  { type: 'secret', id: 's2' },
  null,
  { nope: true },
]);

assert(blocks.length === 8, `expected 8 renderable blocks, got ${blocks.length}`);

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

const swatches = blocks[5] as unknown as { type: string; schemes: Array<{ name?: string; colors: Array<{ hex: string }> }> };
assert(swatches.type === 'swatches', 'valid swatches block should be preserved');
assert(swatches.schemes.length === 1, 'scheme with no valid hex colors should be dropped');
assert(swatches.schemes[0].colors.length === 2, 'only #hex colors should survive (red, rgb(), javascript: dropped)');
assert(swatches.schemes[0].colors[0].hex === '#e0728f', 'hex should be lowercased');
assert(swatches.schemes[0].colors[1].hex === '#abc', 'short #hex should be kept');

const secret = blocks[6] as unknown as Record<string, unknown>;
assert(secret.type === 'secret', 'valid secret block should be preserved');
assert(secret.prompt === 'Paste token', 'secret prompt should be preserved');
assert(secret.placeholder === 'ghp_', 'secret placeholder should be preserved');

const badSecret = blocks[7] as unknown as Record<string, unknown>;
assert(badSecret.type === 'error', 'secret without a prompt should become an error block');
assert(String(badSecret.title).includes('Invalid secret block'), 'secret error title should describe invalid block');

// --- secret redaction (the value must never be persisted) ---
const redacted = redactSecretsForStorage({
  block_response: { block_id: 's1', type: 'secret', value: 'hunter2' },
  block_responses: [
    { block_id: 's1', type: 'secret', value: 'hunter2' },
    { block_id: 'b1', type: 'buttons', value: 'yes' },
  ],
});
assert(redacted.block_response?.value === SECRET_VALUE_MASK, 'single secret response value must be masked');
assert(redacted.block_responses?.[0].value === SECRET_VALUE_MASK, 'secret value in batch must be masked');
assert(redacted.block_responses?.[1].value === 'yes', 'non-secret response value must be untouched');

const noSecret = { block_responses: [{ block_id: 'b', type: 'buttons', value: 'x' }] };
assert(redactSecretsForStorage(noSecret) === noSecret, 'message without secrets returns the same object (no copy)');

console.log('block validation regression OK');
