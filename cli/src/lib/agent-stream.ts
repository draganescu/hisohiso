import { spawnAgent } from './agent-process.js';
import {
  parseClaudeStreamLine,
  parseCodexStreamLine,
  type AgentTurnEvent,
  type TurnStatus,
} from './turn-status.js';

// Run ONE agent turn while streaming, so the daemon can (a) push live status
// into the room and (b) bridge in-turn permission requests out to the operator.
// Replaces the buffered runCommand path for streaming providers (Claude/Codex).

export type StreamFormat = 'claude' | 'codex';

export type PermissionBridge = (req: { tool: string; detail: string }) => Promise<{ allow: boolean }>;

export type StreamTurnArgs = {
  command: string;
  // Transport + mode + resume + system-prompt flags. Does NOT include the prompt
  // — the runner delivers that itself (argv for non-interactive, stdin
  // stream-json for the interactive Claude path).
  argv: string[];
  prompt: string;
  format: StreamFormat;
  env?: Record<string, string>;
  // Ask-mode: wire the permission bridge so the agent pauses for approval.
  interactive?: boolean;
  permission?: PermissionBridge;
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
  const interactive = Boolean(args.interactive && format === 'claude' && args.permission);

  // Build the final argv. Interactive Claude reads the prompt from stdin as a
  // stream-json message and needs --input-format stream-json; everything else
  // takes the prompt as the trailing positional (claude -p <prompt> / codex
  // exec ... <prompt>), exactly as the old buffered path did.
  const argv = [...args.argv];
  if (interactive) {
    argv.push('--input-format', 'stream-json');
  } else {
    argv.push(prompt);
  }

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
        // Interactive runs hold stdin open for control round-trips; once the
        // result lands there's nothing left to send, so close it to let the
        // streaming-input process exit instead of waiting for more input.
        if (interactive) handle.closeStdin();
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
    if (interactive && handleClaudeControl(line, handle, args.permission!)) return;
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

  // Interactive Claude: deliver the prompt as a stream-json user message and
  // leave stdin open for control-request round-trips until the result lands.
  if (interactive) {
    const userMsg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    });
    handle.writeStdin(userMsg + '\n');
  } else {
    handle.closeStdin();
  }

  const exit = await handle.onExit;
  finished = true;
  clearInterval(heartbeat);

  const text = results.length > 0 ? results.join('\n\n').trim() : errors.join('\n').trim();
  emit(isError || exit.code !== 0 ? { kind: 'failed' } : { kind: 'done' });

  return { text, sessionId, code: exit.code, isError };
};

// --- Claude streaming permission bridge -------------------------------------
//
// NEEDS-LIVE-VERIFICATION: the exact control-protocol message shapes below are
// modeled on the Claude Agent SDK's stream-json control channel and must be
// confirmed against the installed `claude` binary before ask-mode is taken out
// of draft. This function is ONLY reached when ask-mode is active (interactive
// === true), so non-interactive modes (plan / auto-edits / full / codex) are
// completely unaffected by anything in here.
//
// Returns true when the line was a control request we handled (and therefore
// must NOT be fed to the normal status parser).
const handleClaudeControl = (
  line: string,
  handle: { writeStdin: (s: string) => void },
  permission: PermissionBridge,
): boolean => {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{' || !trimmed.includes('control_request')) return false;
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (ev.type !== 'control_request') return false;
  const requestId = typeof ev.request_id === 'string' ? ev.request_id : '';
  const request = ev.request as Record<string, unknown> | undefined;
  if (!requestId || !request || request.subtype !== 'can_use_tool') return false;

  const tool = typeof request.tool_name === 'string' ? request.tool_name : 'a tool';
  const input = request.input;
  const detail = summarizeToolInput(input);

  void permission({ tool, detail }).then((decision) => {
    const response = decision.allow
      ? { behavior: 'allow', updatedInput: input ?? {} }
      : { behavior: 'deny', message: 'Denied by operator' };
    const control = JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
    handle.writeStdin(control + '\n');
  });
  return true;
};

// One-line, bounded summary of a tool's input for the approval prompt body.
const summarizeToolInput = (input: unknown): string => {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const candidate =
    (typeof obj.command === 'string' && obj.command) ||
    (typeof obj.file_path === 'string' && obj.file_path) ||
    (typeof obj.path === 'string' && obj.path) ||
    (typeof obj.url === 'string' && obj.url) ||
    '';
  const text = candidate || JSON.stringify(obj);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
};
