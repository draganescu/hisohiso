import { spawnAgent } from './agent-process.js';
import {
  parseClaudeStreamLine,
  parseCodexStreamLine,
  type AgentTurnEvent,
  type TurnStatus,
} from './turn-status.js';

// Run ONE agent turn while streaming, so the daemon can push live status into
// the room. Replaces the buffered runCommand path for streaming providers
// (Claude/Codex). Agents run with full permissions (their profile carries the
// bypass flag) — there is no in-turn approval round-trip.

export type StreamFormat = 'claude' | 'codex';

export type StreamTurnArgs = {
  command: string;
  // Transport + resume + system-prompt flags. Does NOT include the prompt — the
  // runner delivers that as the trailing positional arg.
  argv: string[];
  prompt: string;
  format: StreamFormat;
  env?: Record<string, string>;
  onStatus?: (s: TurnStatus) => void;
};

export type StreamTurnResult = {
  text: string;
  sessionId: string | null;
  code: number | null;
  isError: boolean;
};

// Quiet → stuck escalation thresholds and the heartbeat cadence. Tuned so a long
// build reads as "still working" rather than a false "stuck", while a genuinely
// wedged turn surfaces a Stop button within ~1.5 min.
const QUIET_AFTER_MS = 20_000;
const STUCK_AFTER_MS = 90_000;
const HEARTBEAT_MS = 10_000;

export const runStreamingTurn = async (args: StreamTurnArgs): Promise<StreamTurnResult> => {
  const { command, format, prompt } = args;

  // The prompt is the trailing positional (claude -p <prompt> / codex exec
  // ... <prompt>), exactly as the old buffered path did.
  const argv = [...args.argv, prompt];

  const handle = await spawnAgent(command, argv, {
    env: args.env,
    injectPreamble: false, // prompt is delivered explicitly below, never as a preamble
  });

  const results: string[] = [];
  const errors: string[] = [];
  let sessionId: string | null = null;
  let isError = false;

  let lastActivity = Date.now();
  let currentTool: string | null = null;
  let finished = false;

  // Throttle: only forward a status when something meaningful changed, so a
  // chatty stream doesn't spam the room. The heartbeat forces quiet/stuck.
  let lastKey = '';
  const emit = (s: TurnStatus) => {
    const key = `${s.kind}:${s.tool ?? ''}`;
    if (key === lastKey && s.kind !== 'quiet' && s.kind !== 'stuck') return;
    lastKey = key;
    try {
      args.onStatus?.(s);
    } catch {
      /* status is best-effort; never let it break the turn */
    }
  };

  const applyEvent = (ev: AgentTurnEvent) => {
    lastActivity = Date.now();
    switch (ev.type) {
      case 'session':
        if (ev.sessionId) sessionId = ev.sessionId;
        break;
      case 'assistant_text':
        currentTool = null;
        emit({ kind: 'working' });
        break;
      case 'tool_start':
        currentTool = ev.tool;
        emit({ kind: 'tool', tool: ev.tool });
        break;
      case 'tool_end':
        currentTool = null;
        emit({ kind: 'working' });
        break;
      case 'result':
        if (ev.text) results.push(ev.text);
        if (ev.isError) isError = true;
        break;
      case 'error':
        errors.push(ev.message);
        isError = true;
        break;
    }
  };

  emit({ kind: 'starting' });

  handle.onLine((line, isStderr) => {
    if (isStderr) return; // status comes from the structured stdout stream only
    const events = format === 'claude' ? parseClaudeStreamLine(line) : parseCodexStreamLine(line);
    for (const ev of events) applyEvent(ev);
  });

  // Heartbeat: time-based quiet/stuck escalation independent of the event stream.
  const heartbeat = setInterval(() => {
    if (finished) return;
    const quietMs = Date.now() - lastActivity;
    if (quietMs >= STUCK_AFTER_MS) {
      emit({ kind: 'stuck', quietSec: Math.round(quietMs / 1000) });
    } else if (quietMs >= QUIET_AFTER_MS) {
      emit({ kind: currentTool ? 'tool' : 'quiet', tool: currentTool ?? undefined, quietSec: Math.round(quietMs / 1000) });
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  // Prompt is passed as a positional arg (above); nothing to send on stdin.
  handle.closeStdin();

  const exit = await handle.onExit;
  finished = true;
  clearInterval(heartbeat);

  const text = results.length > 0 ? results.join('\n\n').trim() : errors.join('\n').trim();
  emit(isError || exit.code !== 0 ? { kind: 'failed' } : { kind: 'done' });

  return { text, sessionId, code: exit.code, isError };
};
