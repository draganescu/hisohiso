import type { AgentProvider } from './agent-modes.js';

export type AgentProfile = {
  command: string;
  args: string[];
  description: string;
  mode: 'oneshot' | 'session';
  // Which provider's control surface this agent speaks. Drives streaming-status
  // parsing and approval-mode flag derivation (see agent-modes / agent-stream).
  // Absent => 'other': a plain command with no permission surface (bash/python/…).
  provider?: AgentProvider;
  appendSystemPrompt?: string;
  // Output parser dispatch. Default 'claude-json' = single JSON {result, session_id}.
  // 'codex-ndjson' = JSONL event stream with thread.started + item.completed/agent_message.
  outputFormat?: 'claude-json' | 'codex-ndjson';
  // How to inject appendSystemPrompt. Default 'append-flag' uses --append-system-prompt <value>
  // (Claude). 'prepend-message-once' prepends the prompt to the user message on the first turn
  // only (for agents like codex that lack a system-prompt flag — session continuity carries it).
  systemPromptMode?: 'append-flag' | 'prepend-message-once' | 'codex-config';
  // Build args for a resume turn. If undefined, default behavior is `[...args, '--resume', id]`
  // (Claude). Codex needs `exec resume <id> ...` which can't be expressed as a flag append.
  buildResumeArgs?: (sessionId: string) => string[];
  // Opt-in: when true, the daemon/wrap exports HISOHISO_ROOM_SECRET into the
  // spawned agent's environment. Default (undefined/false) withholds it —
  // the built-in profiles don't need it, and exposing the room secret to e.g.
  // `bash` makes `env | nc …` a one-line exfiltration (finding #97). Custom
  // registered agents that genuinely re-derive keys opt in via
  // `daemon register --needs-room-secret`.
  needsRoomSecret?: boolean;
};

import { BLOCK_PROMPT } from './preamble.js';

const BUILTIN_AGENTS: Record<string, AgentProfile> = {
  'claude': {
    command: 'claude',
    // Transport flags only. Permission flags are derived per-turn from the
    // room's approval mode (agent-modes.flagsForMode) — NO hardcoded bypass.
    // stream-json gives us incremental events for live status (turn-status).
    args: ['-p', '--output-format', 'stream-json', '--verbose'],
    description: 'Claude Code autonomous session (multi-turn)',
    mode: 'session',
    provider: 'claude',
    appendSystemPrompt: BLOCK_PROMPT,
  },
  'claude-once': {
    command: 'claude',
    args: ['-p', '--dangerously-skip-permissions'],
    description: 'Claude Code autonomous (single question)',
    mode: 'oneshot',
    appendSystemPrompt: BLOCK_PROMPT,
  },
  'aider': {
    command: 'aider',
    args: ['--message'],
    description: 'Aider (AI pair programming)',
    mode: 'oneshot',
  },
  'codex': {
    command: 'codex',
    // Transport flags only — sandbox/approval flags come from the room's
    // approval mode (agent-modes.flagsForMode), NOT a hardcoded bypass.
    args: ['exec', '--json', '--skip-git-repo-check'],
    description: 'Codex CLI (OpenAI) autonomous session (multi-turn)',
    mode: 'session',
    provider: 'codex',
    appendSystemPrompt: BLOCK_PROMPT,
    outputFormat: 'codex-ndjson',
    systemPromptMode: 'codex-config',
    buildResumeArgs: (id) => ['exec', 'resume', id, '--json', '--skip-git-repo-check'],
  },
  'codex-once': {
    command: 'codex',
    args: ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'],
    description: 'Codex CLI (OpenAI) autonomous (single question)',
    mode: 'oneshot',
    appendSystemPrompt: BLOCK_PROMPT,
    outputFormat: 'codex-ndjson',
    systemPromptMode: 'codex-config',
  },
  'goose': {
    command: 'goose',
    args: ['run', '--text'],
    description: 'Goose (Block)',
    mode: 'oneshot',
  },
  'bash': {
    command: 'bash',
    args: ['-c'],
    description: 'Run shell commands',
    mode: 'oneshot',
  },
  'python': {
    command: 'python3',
    args: ['-c'],
    description: 'Run Python code',
    mode: 'oneshot',
  },
};

export const getAgent = (name: string): AgentProfile | null => {
  return BUILTIN_AGENTS[name] ?? null;
};

// Resolve a profile's provider, defaulting to 'other' (no permission surface).
export const providerOf = (profile: AgentProfile): AgentProvider => profile.provider ?? 'other';

export const listAgents = (): Record<string, AgentProfile> => {
  return { ...BUILTIN_AGENTS };
};
