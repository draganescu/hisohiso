export type AgentProfile = {
  command: string;
  args: string[];
  description: string;
  mode: 'oneshot' | 'session';
  appendSystemPrompt?: string;
  // Output parser dispatch. Default 'claude-json' = single JSON {result, session_id}.
  // 'codex-ndjson' = JSONL event stream with thread.started + item.completed/agent_message.
  outputFormat?: 'claude-json' | 'codex-ndjson';
  // How to inject appendSystemPrompt. Default 'append-flag' uses --append-system-prompt <value>
  // (Claude). 'prepend-message-once' prepends the prompt to the user message on the first turn
  // only (for agents like codex that lack a system-prompt flag — session continuity carries it).
  systemPromptMode?: 'append-flag' | 'prepend-message-once';
  // Build args for a resume turn. If undefined, default behavior is `[...args, '--resume', id]`
  // (Claude). Codex needs `exec resume <id> ...` which can't be expressed as a flag append.
  buildResumeArgs?: (sessionId: string) => string[];
};

import { BLOCK_PROMPT } from './preamble.js';

const BUILTIN_AGENTS: Record<string, AgentProfile> = {
  'claude': {
    command: 'claude',
    args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions'],
    description: 'Claude Code autonomous session (multi-turn)',
    mode: 'session',
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
    args: ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'],
    description: 'Codex CLI (OpenAI) autonomous session (multi-turn)',
    mode: 'session',
    appendSystemPrompt: BLOCK_PROMPT,
    outputFormat: 'codex-ndjson',
    systemPromptMode: 'prepend-message-once',
    buildResumeArgs: (id) => ['exec', 'resume', id, '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'],
  },
  'codex-once': {
    command: 'codex',
    args: ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'],
    description: 'Codex CLI (OpenAI) autonomous (single question)',
    mode: 'oneshot',
    appendSystemPrompt: BLOCK_PROMPT,
    outputFormat: 'codex-ndjson',
    systemPromptMode: 'prepend-message-once',
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

export const listAgents = (): Record<string, AgentProfile> => {
  return { ...BUILTIN_AGENTS };
};
