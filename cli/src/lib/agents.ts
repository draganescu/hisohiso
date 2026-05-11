export type AgentProfile = {
  command: string;
  args: string[];
  description: string;
};

const BUILTIN_AGENTS: Record<string, AgentProfile> = {
  'claude': {
    command: 'claude',
    args: ['-p'],
    description: 'Claude Code (Anthropic)',
  },
  'aider': {
    command: 'aider',
    args: ['--message'],
    description: 'Aider (AI pair programming)',
  },
  'codex': {
    command: 'codex',
    args: ['-q'],
    description: 'Codex CLI (OpenAI)',
  },
  'goose': {
    command: 'goose',
    args: ['run', '--text'],
    description: 'Goose (Block)',
  },
  'bash': {
    command: 'bash',
    args: ['-c'],
    description: 'Run shell commands',
  },
  'python': {
    command: 'python3',
    args: ['-c'],
    description: 'Run Python code',
  },
};

export const getAgent = (name: string): AgentProfile | null => {
  return BUILTIN_AGENTS[name] ?? null;
};

export const listAgents = (): Record<string, AgentProfile> => {
  return { ...BUILTIN_AGENTS };
};
