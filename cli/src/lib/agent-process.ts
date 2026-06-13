import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { getPreamble } from './preamble.js';
import { sanitizeBlocks } from './safe-href.js';

export type AgentHandle = {
  writeStdin: (data: string) => void;
  closeStdin: () => void;
  onLine: (callback: (line: string, isStderr: boolean) => void) => void;
  onExit: Promise<{ code: number | null; signal: string | null }>;
  // Resolves when the stdout line reader has flushed and closed. The 'exit'
  // event can fire before readline emits the final buffered line, so callers
  // that need the last line (e.g. a streaming provider's terminal `result`
  // event) must await this AFTER onExit, not race on exit alone.
  stdoutClosed: Promise<void>;
  kill: () => void;
  pid: number | undefined;
};

export type SpawnOptions = {
  preambleAgent?: string;
  env?: Record<string, string>;
  injectPreamble?: boolean;
  shellCommand?: boolean;
};

export const runCommand = (command: string, args: string[], options: SpawnOptions = {}): Promise<{ stdout: string; stderr: string; code: number | null }> => {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env ?? {}) },
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
 * agent_message item.completed event in order. turn.failed / error events are collected as
 * failure messages so the phone surfaces a human-readable string instead of raw event JSON
 * when codex bails out before emitting any agent_message. Non-JSON lines are skipped
 * silently — codex has been known to print occasional warnings on stdout alongside the
 * JSONL stream.
 */
export const parseCodexNdjson = (stdout: string): { text: string; sessionId: string | null } => {
  let sessionId: string | null = null;
  const agentMessages: string[] = [];
  const failures: string[] = [];

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
    } else if (type === 'turn.failed' || type === 'error') {
      // Field name varies between event types and codex versions; try the common ones.
      const msg = (event.message ?? event.reason ?? event.error) as unknown;
      failures.push(typeof msg === 'string' && msg.length > 0 ? msg : `(codex ${type})`);
    }
  }

  // Prefer agent text. Fall back to failure messages so the phone shows a useful string
  // instead of raw JSONL when codex errored out before producing any agent_message.
  let text: string;
  if (agentMessages.length > 0) {
    text = agentMessages.join('\n\n').trim();
  } else if (failures.length > 0) {
    text = failures.join('\n').trim();
  } else {
    text = stdout.trim() || '(no output)';
  }

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
 * Scan `text` for every complete top-level JSON object and keep the ones shaped
 * like a block envelope (an object with a string `text` field). Codex emits one
 * `agent_message` per preamble PLUS the final answer, and the daemon joins them
 * with "\n\n" (see parseCodexNdjson / parseCodexStreamLine). Because BLOCK_PROMPT
 * tells the agent its ENTIRE response must be one raw JSON object, a codex turn
 * can carry several envelopes back to back — a leading preamble
 * (`{"text":"Inspecting…"}`) ahead of the real answer
 * (`{"text":"…","blocks":[…]}`). Returning all of them lets the caller pick the
 * final answer instead of the first preamble, which would otherwise shadow the
 * answer's blocks and silently drop them (#187).
 */
const findBlockEnvelopes = (text: string): Array<{ text: string; blocks: unknown[] | null }> => {
  const envelopes: Array<{ text: string; blocks: unknown[] | null }> = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let objStart = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          const obj = JSON.parse(text.substring(objStart, i + 1)) as Record<string, unknown>;
          if (typeof obj.text === 'string') {
            const blocks = Array.isArray(obj.blocks) && obj.blocks.length > 0 ? obj.blocks : null;
            envelopes.push({ text: obj.text, blocks });
          }
        } catch { /* not an envelope (prose with braces, partial object) — skip */ }
        objStart = -1;
      }
    }
  }

  return envelopes;
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
      return { text: obj.text, blocks: sanitizeBlocks(blocks) };
    }
  } catch { /* not valid JSON, try extraction */ }

  // Pull out every complete envelope, then pick the FINAL answer. Codex prepends
  // preamble envelopes before the answer; taking the first (as a naive
  // first-`{"text":` match does) would surface the preamble and drop the
  // answer's blocks (#187). Prefer the last envelope that actually carries
  // blocks, falling back to the last envelope overall — the answer is always
  // last, and this also survives a trailing block-less sign-off envelope.
  const envelopes = findBlockEnvelopes(text);
  if (envelopes.length > 0) {
    const chosen =
      [...envelopes].reverse().find((e) => e.blocks && e.blocks.length > 0)
      ?? envelopes[envelopes.length - 1]!;
    return { text: chosen.text, blocks: sanitizeBlocks(chosen.blocks) };
  }

  // No complete envelope parsed — the JSON is likely truncated. Strip code
  // fences / preamble / trailing junk, then salvage the text field and any
  // complete blocks from the envelope-shaped fragment.
  const jsonPart = extractJsonContent(text);
  if (!jsonPart) return null;

  const textFieldMatch = jsonPart.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!textFieldMatch) return null;

  let extracted: string;
  try {
    extracted = JSON.parse(`"${textFieldMatch[1]}"`) as string;
  } catch {
    return null;
  }

  const blocks = extractCompleteBlocks(jsonPart);
  return { text: extracted, blocks: sanitizeBlocks(blocks) };
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

  // Resolves when stdout's reader closes (EOF), so callers can wait for the last
  // line to flush after the process exits. Resolved immediately if there is no
  // stdout stream to read.
  let resolveStdoutClosed: () => void;
  const stdoutClosed = new Promise<void>((resolve) => { resolveStdoutClosed = resolve; });

  const setupLineReader = (stream: Readable | null, isStderr: boolean) => {
    if (!stream) {
      if (!isStderr) resolveStdoutClosed();
      return;
    }
    const rl = createInterface({ input: stream });
    rl.on('line', (line) => {
      for (const cb of lineCallbacks) {
        cb(line, isStderr);
      }
    });
    if (!isStderr) rl.on('close', () => resolveStdoutClosed());
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
    // A spawn failure (ENOENT / EACCES) emits 'error' and never 'exit'. Without
    // this handler the promise would hang forever (the turn never completes,
    // session stays "running") AND Node would throw the unhandled 'error' as an
    // uncaught exception, taking down the daemon. Surface the message on the
    // stderr line stream and resolve with a non-zero code so callers fail the
    // turn cleanly. (runCommand has the same handler; spawnAgent lacked it.)
    child.on('error', (err) => {
      for (const cb of lineCallbacks) cb(`spawn error: ${err.message}`, true);
      resolveStdoutClosed();
      resolve({ code: 1, signal: null });
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
    stdoutClosed,
    kill: () => {
      child.kill('SIGTERM');
    },
    pid: child.pid,
  };
};
