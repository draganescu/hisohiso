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
