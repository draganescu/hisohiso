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

/**
 * Parse codex's `--json` JSONL event stream.
 *
 * Event shapes (codex v0.44+):
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"type":"command_execution",...}}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *   {"type":"turn.completed"} | {"type":"turn.failed"} | {"type":"error",...}
 *
 * We extract the thread_id (codex's session handle) and the concatenated text of every
 * agent_message item.completed event in order. Non-JSON lines are skipped silently — codex
 * has been known to print occasional warnings on stdout alongside the JSONL stream.
 */
export const parseCodexNdjson = (stdout: string): { text: string; sessionId: string | null } => {
  let sessionId: string | null = null;
  const agentMessages: string[] = [];

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line || line[0] !== '{') continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = event.type as string | undefined;
    if (type === 'thread.started') {
      const tid = event.thread_id as string | undefined;
      if (tid) sessionId = tid;
    } else if (type === 'item.completed') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item && item.type === 'agent_message' && typeof item.text === 'string') {
        agentMessages.push(item.text);
      }
    }
  }

  const text = agentMessages.join('\n\n').trim() || stdout.trim() || '(no output)';
  return { text, sessionId };
};

/**
 * Extract complete top-level JSON objects from a potentially truncated "blocks" array.
 * Tracks brace depth and string state to find complete block boundaries.
 */
const extractCompleteBlocks = (jsonText: string): unknown[] | null => {
  const match = jsonText.match(/"blocks"\s*:\s*\[/);
  if (!match || match.index === undefined) return null;

  const arrayStart = match.index + match[0].length;
  const blocks: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let blockStart = -1;

  for (let i = arrayStart; i < jsonText.length; i++) {
    const ch = jsonText[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (inString) {
      if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    // Not in string
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) blockStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && blockStart >= 0) {
        const blockStr = jsonText.substring(blockStart, i + 1);
        try {
          blocks.push(JSON.parse(blockStr));
        } catch { /* skip malformed block */ }
        blockStart = -1;
      }
    } else if (ch === ']' && depth === 0) {
      break;
    }
  }

  return blocks.length > 0 ? blocks : null;
};

/**
 * Find the JSON portion of the output, stripping code fences, preamble, and
 * trailing junk (e.g. extra `]}` that Claude sometimes appends).
 * Uses brace-depth tracking to find the true end of the JSON object.
 * Returns null if no block JSON pattern (`{"text":`) is found.
 */
const extractJsonContent = (text: string): string | null => {
  const jsonMatch = text.match(/\{[\s]*"text"\s*:/);
  if (!jsonMatch || jsonMatch.index === undefined) return null;

  let jsonPart = text.substring(jsonMatch.index);

  // Strip trailing markdown code fence and any text after it
  jsonPart = jsonPart.replace(/\n\s*```[\s\S]*$/, '');
  jsonPart = jsonPart.replace(/```\s*$/, '');

  // Track brace depth to find the matching closing } for the opening {.
  // This strips trailing junk like extra ]} that Claude sometimes emits.
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < jsonPart.length; i++) {
    const ch = jsonPart[i]!;
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return jsonPart.substring(0, i + 1);
    }
  }

  // No matching brace found — JSON is truncated, return as-is for salvage path
  return jsonPart;
};

/**
 * Returns `null` when no block-style JSON envelope could be detected, so the
 * caller can fall back to the raw output. Returns `{ text, blocks }` whenever
 * a `"text"` field was extracted, even if there are no blocks attached.
 */
export const parseBlockOutput = (text: string): { text: string; blocks: unknown[] | null } | null => {
  // Happy path: entire text is valid block JSON
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (typeof obj.text === 'string') {
      const blocks = Array.isArray(obj.blocks) && obj.blocks.length > 0 ? obj.blocks : null;
      return { text: obj.text, blocks };
    }
  } catch { /* not valid JSON, try extraction */ }

  // Extract JSON portion — strips code fences, preamble, trailing junk
  const jsonPart = extractJsonContent(text);
  if (!jsonPart) return null;

  // Try parsing the cleaned JSON
  try {
    const obj = JSON.parse(jsonPart) as Record<string, unknown>;
    if (typeof obj.text === 'string') {
      const blocks = Array.isArray(obj.blocks) && obj.blocks.length > 0 ? obj.blocks : null;
      return { text: obj.text, blocks };
    }
  } catch { /* JSON is truncated, try to salvage */ }

  // JSON is truncated — extract text field and any complete blocks
  const textFieldMatch = jsonPart.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!textFieldMatch) return null;

  let extracted: string;
  try {
    extracted = JSON.parse(`"${textFieldMatch[1]}"`) as string;
  } catch {
    return null;
  }

  const blocks = extractCompleteBlocks(jsonPart);
  return { text: extracted, blocks };
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
