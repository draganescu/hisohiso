export type AgentProfile = {
  command: string;
  args: string[];
  description: string;
  mode: 'oneshot' | 'session';
};

const BUILTIN_AGENTS: Record<string, AgentProfile> = {
  'claude': {
    command: 'claude',
    args: ['-p', '--output-format', 'json'],
    description: 'Claude Code session (multi-turn)',
    mode: 'session',
  },
  'claude-once': {
    command: 'claude',
    args: ['-p'],
    description: 'Claude Code (single question)',
    mode: 'oneshot',
  },
  'aider': {
    command: 'aider',
    args: ['--message'],
    description: 'Aider (AI pair programming)',
    mode: 'oneshot',
  },
  'codex': {
    command: 'codex',
    args: ['-q'],
    description: 'Codex CLI (OpenAI)',
    mode: 'oneshot',
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
