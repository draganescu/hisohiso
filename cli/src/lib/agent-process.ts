import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { getPreamble } from './preamble.js';

export type AgentHandle = {
  writeStdin: (data: string) => void;
  onLine: (callback: (line: string, isStderr: boolean) => void) => void;
  onExit: Promise<{ code: number | null; signal: string | null }>;
  kill: () => void;
  pid: number | undefined;
};

export const spawnAgent = async (
  command: string,
  args: string[] = [],
  options?: { preambleAgent?: string; env?: Record<string, string> }
): Promise<AgentHandle> => {
  const child: ChildProcess = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
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

  // Inject preamble
  const preamble = await getPreamble(options?.preambleAgent);
  child.stdin?.write(preamble + '\n');

  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });

  return {
    writeStdin: (data: string) => {
      child.stdin?.write(data);
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
