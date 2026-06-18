import { afterEach, describe, expect, test } from 'bun:test';

// Focused coverage of the non-interactive session-knock-message resolution that
// `cli/src/commands/wrap.ts` and the daemon's `setupControlRoom`
// (`cli/src/daemon/daemon-main.ts`) perform inline. The production code reads
// the value straight off `process.env` (and `delete`s it after use), so neither
// site exports a helper to import. This mirrors that exact branch logic as a
// pure resolver and asserts the contract: HISOHISO_KNOCK_MESSAGE when set &
// non-empty is used (no prompt), an explicitly-set empty value is rejected
// exactly as an empty prompt line, and an unset var falls through to the
// interactive prompt unchanged.
//
// Resolution is one of: { source: 'env', value } | { source: 'prompt' }, with
// an empty env value modelled as `reject` (the production path prints the same
// "Knock message cannot be empty" error and exits non-zero).
type Resolution =
  | { source: 'env'; value: string }
  | { source: 'reject' }
  | { source: 'prompt' };

const resolveKnockMessage = (env: NodeJS.ProcessEnv): Resolution => {
  if (typeof env.HISOHISO_KNOCK_MESSAGE === 'string') {
    const value = env.HISOHISO_KNOCK_MESSAGE;
    // Consume once so it can't leak into spawned children's env.
    delete env.HISOHISO_KNOCK_MESSAGE;
    if (value === '') return { source: 'reject' };
    return { source: 'env', value };
  }
  return { source: 'prompt' };
};

describe('HISOHISO_KNOCK_MESSAGE resolution', () => {
  afterEach(() => {
    delete process.env.HISOHISO_KNOCK_MESSAGE;
  });

  test('set & non-empty: used, no prompt', () => {
    const env = { HISOHISO_KNOCK_MESSAGE: 'open sesame' } as NodeJS.ProcessEnv;
    expect(resolveKnockMessage(env)).toEqual({ source: 'env', value: 'open sesame' });
  });

  test('set & non-empty: consumed (deleted) after use so it cannot leak', () => {
    const env = { HISOHISO_KNOCK_MESSAGE: 'open sesame' } as NodeJS.ProcessEnv;
    resolveKnockMessage(env);
    expect('HISOHISO_KNOCK_MESSAGE' in env).toBe(false);
  });

  test('set & non-empty preserves the exact value (no trimming)', () => {
    const env = { HISOHISO_KNOCK_MESSAGE: '  spaced secret  ' } as NodeJS.ProcessEnv;
    expect(resolveKnockMessage(env)).toEqual({ source: 'env', value: '  spaced secret  ' });
  });

  test('set & empty: rejected (does NOT fall through to the prompt)', () => {
    const env = { HISOHISO_KNOCK_MESSAGE: '' } as NodeJS.ProcessEnv;
    expect(resolveKnockMessage(env)).toEqual({ source: 'reject' });
  });

  test('unset: falls through to the interactive prompt unchanged', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(resolveKnockMessage(env)).toEqual({ source: 'prompt' });
  });
});
