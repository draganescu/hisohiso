// Turn status: read an agent's streaming output as STATE, not content.
//
// The point is progress, not a token firehose: we parse the same event stream
// Claude/Codex already emit, reduce it to a coarse status, and let the
// agent-manager push a compact, throttled status block into the room. None of
// the agent's prose is forwarded from here — only "what is it doing right now".

// Normalized, provider-agnostic events extracted from one stream line.
export type AgentTurnEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'assistant_text' }
  | { type: 'tool_start'; tool: string }
  | { type: 'tool_end'; tool?: string }
  | { type: 'result'; text: string; isError: boolean }
  | { type: 'error'; message: string };

// The predictable status the phone renders. Time-based escalation ('quiet' →
// 'stuck') is computed by the runner's heartbeat, not the event reducer.
export type TurnStatusKind = 'starting' | 'working' | 'tool' | 'quiet' | 'stuck' | 'done' | 'failed';

export type TurnStatus = {
  kind: TurnStatusKind;
  // The active tool name, when kind === 'tool'.
  tool?: string;
  // Seconds since the last stream event — surfaced for 'quiet' / 'stuck'.
  quietSec?: number;
};

const textOf = (v: unknown): string => (typeof v === 'string' ? v : '');

// Decode one stream line to a JSON object, or null for blanks / non-`{` lines /
// malformed JSON (both providers occasionally print plain warnings inline). One
// guard shared by both stream parsers instead of three copies.
const tryParseLine = (line: string): Record<string, unknown> | null => {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
};

// Parse one Claude `--output-format stream-json` line into normalized events.
// Tolerant: unknown shapes and non-JSON lines yield [].
export const parseClaudeStreamLine = (line: string): AgentTurnEvent[] => {
  const ev = tryParseLine(line);
  if (!ev) return [];
  const out: AgentTurnEvent[] = [];
  const type = ev.type as string | undefined;

  if (type === 'system' && (ev.subtype as string) === 'init') {
    const sid = textOf(ev.session_id);
    if (sid) out.push({ type: 'session', sessionId: sid });
    return out;
  }
  if (type === 'assistant') {
    const message = ev.message as Record<string, unknown> | undefined;
    const content = (message?.content as Array<Record<string, unknown>> | undefined) ?? [];
    for (const part of content) {
      if (part.type === 'tool_use') {
        out.push({ type: 'tool_start', tool: textOf(part.name) || 'tool' });
      } else if (part.type === 'text' || part.type === 'thinking') {
        // Count extended thinking as activity too, so a long reasoning phase
        // reads as "working" and doesn't let the heartbeat drift to quiet/stuck.
        out.push({ type: 'assistant_text' });
      }
    }
    return out;
  }
  if (type === 'user') {
    const message = ev.message as Record<string, unknown> | undefined;
    const content = (message?.content as Array<Record<string, unknown>> | undefined) ?? [];
    for (const part of content) {
      if (part.type === 'tool_result') out.push({ type: 'tool_end' });
    }
    return out;
  }
  if (type === 'result') {
    const sid = textOf(ev.session_id);
    if (sid) out.push({ type: 'session', sessionId: sid });
    out.push({ type: 'result', text: textOf(ev.result), isError: ev.is_error === true });
    return out;
  }
  return out;
};

// Parse one Codex `--json` ndjson line into normalized events. Mirrors the
// event shapes already handled by parseCodexNdjson, but line-at-a-time.
export const parseCodexStreamLine = (line: string): AgentTurnEvent[] => {
  const ev = tryParseLine(line);
  if (!ev) return [];
  const out: AgentTurnEvent[] = [];
  const type = ev.type as string | undefined;

  if (type === 'thread.started') {
    const tid = textOf(ev.thread_id);
    if (tid) out.push({ type: 'session', sessionId: tid });
    return out;
  }
  if (type === 'item.started') {
    const item = ev.item as Record<string, unknown> | undefined;
    const itype = item?.type as string | undefined;
    if (itype && itype !== 'agent_message') {
      out.push({ type: 'tool_start', tool: codexToolLabel(itype, item) });
    }
    return out;
  }
  if (type === 'item.completed') {
    const item = ev.item as Record<string, unknown> | undefined;
    const itype = item?.type as string | undefined;
    if (itype === 'agent_message' && typeof item?.text === 'string') {
      out.push({ type: 'result', text: item.text, isError: false });
    } else if (itype) {
      out.push({ type: 'tool_end' });
    }
    return out;
  }
  if (type === 'turn.failed' || type === 'error') {
    const msg = (ev.message ?? ev.reason ?? ev.error) as unknown;
    out.push({ type: 'error', message: typeof msg === 'string' && msg ? msg : `codex ${type}` });
    return out;
  }
  return out;
};

// Human label for a codex work item ("command_execution" -> "running command").
const codexToolLabel = (itemType: string, item?: Record<string, unknown>): string => {
  switch (itemType) {
    case 'command_execution': {
      const cmd = textOf(item?.command);
      return cmd ? `running: ${cmd.slice(0, 48)}` : 'running command';
    }
    case 'file_change':
    case 'patch':
      return 'editing files';
    case 'mcp_tool_call':
      return 'calling tool';
    case 'web_search':
      return 'searching the web';
    default:
      return itemType.replace(/_/g, ' ');
  }
};

// Compact, human one-liner for a status — sent as the ephemeral status text the
// phone renders in its single in-place "agent is working" indicator.
export const describeStatus = (s: TurnStatus): string => {
  switch (s.kind) {
    case 'starting':
      return 'Starting…';
    case 'working':
      return 'Working…';
    case 'tool': {
      const label = s.tool ?? 'Running a tool';
      // A tool that has been running a while gets an elapsed suffix so a healthy
      // long build reads as progressing rather than appearing frozen.
      return s.quietSec && s.quietSec >= 20 ? `${label}… (${s.quietSec}s)` : `${label}…`;
    }
    case 'quiet':
      return `Still working (${s.quietSec ?? 0}s)`;
    case 'stuck':
      return `No activity for ${s.quietSec ?? 0}s — possibly stuck`;
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
  }
};
