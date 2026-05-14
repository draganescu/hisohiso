import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { getPreamble } from './preamble.js';

export type AgentHandle = {
  writeStdin: (data: string) => void;
  closeStdin: () => void;
  onLine: (callback: (line: string, isStderr: boolean) => void) => void;
  onExit: Promise<{ code: number | null; signal: string | null }>;
  kill: () => void;
  pid: number | undefined;
};

export type SpawnOptions = {
  preambleAgent?: string;
  env?: Record<string, string>;
  injectPreamble?: boolean;
  shellCommand?: boolean;
};

export const runCommand = (command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> => {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('exit', (code) => {
      resolve({ stdout, stderr, code });
    });

    child.on('error', (err) => {
      resolve({ stdout, stderr: err.message, code: 1 });
    });
  });
};

export const parseJsonOutput = (stdout: string): { text: string; sessionId: string | null } => {
  try {
    const json = JSON.parse(stdout.trim()) as Record<string, unknown>;
    return {
      text: (json.result as string) ?? stdout.trim(),
      sessionId: (json.session_id as string) ?? null,
    };
  } catch {
    return { text: stdout.trim() || '(no output)', sessionId: null };
  }
};

export const parseBlockOutput = (text: string): { text: string; blocks: unknown[] | null } => {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (typeof obj.text === 'string') {
      const blocks = Array.isArray(obj.blocks) && obj.blocks.length > 0 ? obj.blocks : null;
      return { text: obj.text, blocks };
    }
  } catch { /* not block JSON, fall through */ }
  return { text, blocks: null };
};

export const spawnAgent = async (
  command: string,
  args: string[] = [],
  options?: SpawnOptions
): Promise<AgentHandle> => {
  // shellCommand: true means command is a shell string (from registry).
  // false/default: command + args are passed directly (preserves spaces in args).
  const useShell = options?.shellCommand ?? false;

  const child: ChildProcess = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: useShell,
    env: { ...process.env, ...options?.env },
  });

  const lineCallbacks: Array<(line: string, isStderr: boolean) => void> = [];

  const setupLineReader = (stream: Readable | null, isStderr: boolean) => {
    if (!stream) return;
    const rl = createInterface({ input: stream });
    rl.on('line', (line) => {
      for (const cb of lineCallbacks) {
        cb(line, isStderr);
      }
    });
  };

  setupLineReader(child.stdout, false);
  setupLineReader(child.stderr, true);

  // Optionally inject preamble to stdin
  if (options?.injectPreamble !== false) {
    const preamble = await getPreamble(options?.preambleAgent);
    child.stdin?.write(preamble + '\n');
  }

  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });

  return {
    writeStdin: (data: string) => {
      child.stdin?.write(data);
    },
    closeStdin: () => {
      child.stdin?.end();
    },
    onLine: (callback) => {
      lineCallbacks.push(callback);
    },
    onExit: exitPromise,
    kill: () => {
      child.kill('SIGTERM');
    },
    pid: child.pid,
  };
};
