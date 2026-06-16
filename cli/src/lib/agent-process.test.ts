import { describe, expect, test } from 'bun:test';
import { parseBlockOutput, parseCodexNdjson } from './agent-process.js';

// Regression coverage for #187: codex emits one `agent_message` per preamble
// PLUS the final answer, and the daemon joins them with "\n\n". Because the
// block contract tells the agent its ENTIRE response must be a single raw JSON
// object, a codex turn arrives as several envelopes back to back. The parser
// must surface the FINAL answer (with its blocks), not the leading preamble.

const codexMessages = (texts: string[]): string =>
  [
    '{"type":"thread.started","thread_id":"t1"}',
    ...texts.map((t) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: t } })),
    '{"type":"turn.completed"}',
  ].join('\n');

describe('parseBlockOutput', () => {
  test('single envelope with blocks (happy path)', () => {
    const out = parseBlockOutput('{"text":"hi","blocks":[{"type":"list","items":["a"]}]}');
    expect(out?.text).toBe('hi');
    expect(out?.blocks).toEqual([{ type: 'list', items: ['a'] }]);
  });

  test('text-only envelope carries no blocks', () => {
    const out = parseBlockOutput('{"text":"just text"}');
    expect(out?.text).toBe('just text');
    expect(out?.blocks).toBeNull();
  });

  test('prose preamble before the answer envelope still yields the blocks', () => {
    const out = parseBlockOutput('I will inspect the repo.\n\n{"text":"done","blocks":[{"type":"list","items":["a"]}]}');
    expect(out?.text).toBe('done');
    expect(out?.blocks).toEqual([{ type: 'list', items: ['a'] }]);
  });

  test('#187: a leading preamble ENVELOPE must not shadow the answer blocks', () => {
    // The exact failure mode: a `{"text":...}` preamble joined ahead of the
    // real answer. The naive first-`{"text":` match returned the preamble and
    // dropped the blocks; the answer must win instead.
    const joined = '{"text":"Inspecting the repo now."}\n\n{"text":"All set","blocks":[{"type":"list","items":["one","two"]}]}';
    const out = parseBlockOutput(joined);
    expect(out?.text).toBe('All set');
    expect(out?.blocks).toEqual([{ type: 'list', items: ['one', 'two'] }]);
  });

  test('#187: blocks survive even when a block-less sign-off envelope trails the answer', () => {
    const joined = '{"text":"Working…"}\n\n{"text":"answer","blocks":[{"type":"list","items":["x"]}]}\n\n{"text":"Done!"}';
    const out = parseBlockOutput(joined);
    expect(out?.text).toBe('answer');
    expect(out?.blocks).toEqual([{ type: 'list', items: ['x'] }]);
  });

  test('multiple text-only envelopes fall back to the last one', () => {
    const out = parseBlockOutput('{"text":"first"}\n\n{"text":"second"}');
    expect(out?.text).toBe('second');
    expect(out?.blocks).toBeNull();
  });

  test('not block JSON at all returns null so the caller keeps raw output', () => {
    expect(parseBlockOutput('plain agent reply, no json')).toBeNull();
  });

  test('end-to-end: codex preamble+answer through parseCodexNdjson then parseBlockOutput (#187)', () => {
    const ndjson = codexMessages([
      '{"text":"Inspecting the repo now."}',
      '{"text":"ASCILINE summary","blocks":[{"type":"list","style":"bullet","items":["a","b"]}]}',
    ]);
    const { text: joined } = parseCodexNdjson(ndjson);
    const out = parseBlockOutput(joined);
    expect(out?.text).toBe('ASCILINE summary');
    expect(out?.blocks).toEqual([{ type: 'list', style: 'bullet', items: ['a', 'b'] }]);
  });
});
