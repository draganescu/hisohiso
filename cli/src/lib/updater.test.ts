import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInstalledBinary, resolveExecPath } from './updater.js';

describe('isInstalledBinary', () => {
  test('true for a Bun single-file executable (/$bunfs entry at argv[1])', () => {
    expect(isInstalledBinary(['/home/u/.local/bin/hisohiso', '/$bunfs/root/index.ts', 'update'])).toBe(true);
  });

  test('false for a source run under bun (real script at argv[1])', () => {
    expect(isInstalledBinary(['bun', '/repo/cli/src/index.ts', 'daemon', 'start'])).toBe(false);
  });

  // Regression for #228: the exact shape that overwrote the nvm `node` binary.
  // argv[0] is the interpreter; without this gate the updater renamed the
  // downloaded hisohiso binary over node, bricking codex/npm/npx.
  test('false when argv[0] is node and argv[1] is a script (the clobber case)', () => {
    expect(
      isInstalledBinary(['/home/u/.nvm/versions/node/v20.13.1/bin/node', '/some/script.js', 'update'])
    ).toBe(false);
  });

  test('false when argv is empty or too short', () => {
    expect(isInstalledBinary([])).toBe(false);
    expect(isInstalledBinary(['only-one'])).toBe(false);
  });
});

describe('resolveExecPath', () => {
  test('compiled binary: returns the real execPath, never argv[0]', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hiso-exec-')));
    const bin = join(dir, 'hisohiso');
    writeFileSync(bin, '');
    // argv[0] is a bogus interpreter path; a compiled binary must trust execPath.
    const got = resolveExecPath(['/usr/bin/node', '/$bunfs/root/index.ts', 'update'], bin);
    expect(got).toBe(bin);
  });

  test('compiled binary with a virtual /$bunfs execPath: falls back to argv[0]', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hiso-exec-')));
    const bin = join(dir, 'hisohiso');
    writeFileSync(bin, '');
    const got = resolveExecPath([bin, '/$bunfs/root/index.ts', 'update'], '/$bunfs/root/index.ts');
    expect(got).toBe(bin);
  });

  test('source run: returns the real interpreter (process.execPath), never the injected argv[0]', () => {
    const fakeNode = '/home/u/.nvm/versions/node/v20.13.1/bin/node';
    const got = resolveExecPath([fakeNode, '/some/script.js', 'update'], fakeNode);
    // Crucially NOT the interpreter path the caller passed — that was the swap
    // target that clobbered node (#228).
    expect(got).not.toBe(fakeNode);
    expect(got).toBe(process.execPath);
  });
});
