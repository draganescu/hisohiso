// Small child-process helpers shared by the relay + test-loop scripts.
import { spawn } from 'node:child_process';

// Run a command to completion, capturing stdout/stderr. Never rejects on a
// nonzero exit — callers inspect `code` so they can attach context.
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: String(err?.message ?? err) }));
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

// Stream a command to the parent's stdio (for noisy `up --build`). Resolves the
// exit code; never rejects.
export function runInherit(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
