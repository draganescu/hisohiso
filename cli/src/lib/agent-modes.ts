// Per-agent approval modes.
//
// Replaces the old hardcoded "always bypass" launch flags
// (--dangerously-skip-permissions for Claude,
// --dangerously-bypass-approvals-and-sandbox for Codex) with a per-room setting
// the operator can change at any time during a session. Each provider exposes
// its own catalog of modes; the daemon stores one mode per agent room and
// derives the launch flags from it on every turn (turns are spawned fresh, so a
// mode change simply takes effect on the next turn — see agent-manager).

export type AgentProvider = 'claude' | 'codex' | 'other';

// A normalized approval mode id. Not every id is valid for every provider —
// modesFor(provider) returns the supported subset and flagsForMode() maps the id
// to that provider's real CLI flags.
export type ApprovalModeId =
  | 'plan' // read-only planning, no execution (Claude)
  | 'read-only' // read-only sandbox, never asks (Codex)
  | 'ask' // prompt before each risky tool — interactive approvals
  | 'auto-edits' // auto-accept file edits, ask for the rest (Claude)
  | 'auto' // run freely inside a workspace sandbox, no prompts (Codex)
  | 'full'; // no prompts, no sandbox — the old default

export type ApprovalMode = {
  id: ApprovalModeId;
  label: string;
  description: string;
  // True when this mode makes the agent pause and ask for approval mid-turn.
  // The daemon only needs to wire the streaming permission bridge for these.
  interactive: boolean;
};

const CLAUDE_MODES: ApprovalMode[] = [
  { id: 'plan', label: 'Plan (read-only)', description: 'Explores and proposes; executes nothing.', interactive: false },
  { id: 'ask', label: 'Ask each time', description: 'Asks before each non-allowlisted tool.', interactive: true },
  { id: 'auto-edits', label: 'Auto-accept edits', description: 'Applies file edits automatically; asks before commands.', interactive: true },
  { id: 'full', label: 'Full access', description: 'No prompts. Only when you trust the task.', interactive: false },
];

// No 'ask' here: codex's `exec` transport is one-shot (prompt in, events out,
// exit) so it can't answer an approval mid-run, and codex 0.137 has no `proto`
// subcommand. Interactive approvals need the `mcp-server` transport (elicitation
// bridge), tracked as a follow-up. Until then codex offers only non-interactive
// sandbox modes.
const CODEX_MODES: ApprovalMode[] = [
  { id: 'read-only', label: 'Read-only', description: 'Read-only sandbox; never runs commands.', interactive: false },
  { id: 'auto', label: 'Sandboxed auto', description: 'Runs freely inside a workspace sandbox; no prompts.', interactive: false },
  { id: 'full', label: 'Full access', description: 'No sandbox, no prompts. The old default.', interactive: false },
];

export const modesFor = (provider: AgentProvider): ApprovalMode[] => {
  if (provider === 'claude') return CLAUDE_MODES;
  if (provider === 'codex') return CODEX_MODES;
  return [];
};

// Safe-by-default: new rooms open in the most restrictive mode that still lets
// the agent do useful read-only work — NEVER 'full'. The operator must opt into
// looser modes. (Was: every agent launched with bypass-everything.)
export const defaultModeFor = (provider: AgentProvider): ApprovalModeId => {
  if (provider === 'claude') return 'plan';
  if (provider === 'codex') return 'read-only';
  // bash/python/aider etc. have no permission surface — leave them unflagged.
  return 'full';
};

export const isValidModeFor = (provider: AgentProvider, id: string): id is ApprovalModeId =>
  modesFor(provider).some((m) => m.id === id);

export const modeMeta = (provider: AgentProvider, id: ApprovalModeId): ApprovalMode | undefined =>
  modesFor(provider).find((m) => m.id === id);

export const isInteractiveMode = (provider: AgentProvider, id: ApprovalModeId): boolean =>
  modeMeta(provider, id)?.interactive ?? false;

// Map a mode id to the provider's real launch flags. These REPLACE the flags
// that used to be hardcoded in agents.ts. 'other' providers (bash/python/aider)
// get nothing — they have no permission surface to gate.
//
// NOTE on Claude 'ask': `--permission-mode default` only produces interactive
// prompts when the daemon also bridges the request out to the room (see
// agent-stream PermissionBridge). The daemon selects 'ask' together with the
// bridge, so the two always travel together.
//
// NOTE on Codex: `exec` takes the approval policy via `-c approval_policy=…`.
// The top-level `--ask-for-approval` flag does NOT exist on the `exec`
// subcommand and makes it exit 2. exec is also one-shot and can't answer an
// approval mid-run, so codex has no interactive 'ask' mode (see CODEX_MODES).
export const flagsForMode = (provider: AgentProvider, id: ApprovalModeId): string[] => {
  if (provider === 'claude') {
    switch (id) {
      case 'plan':
        return ['--permission-mode', 'plan'];
      case 'ask':
        return ['--permission-mode', 'default'];
      case 'auto-edits':
        return ['--permission-mode', 'acceptEdits'];
      case 'full':
        // Preserve the exact previously-shipped behavior for the explicit
        // opt-in: the canonical headless bypass flag.
        return ['--dangerously-skip-permissions'];
      default:
        return ['--permission-mode', 'plan'];
    }
  }
  if (provider === 'codex') {
    switch (id) {
      case 'read-only':
        return ['--sandbox', 'read-only', '-c', 'approval_policy=never'];
      case 'auto':
        return ['--sandbox', 'workspace-write', '-c', 'approval_policy=never'];
      case 'full':
        return ['--dangerously-bypass-approvals-and-sandbox'];
      // 'ask' is intentionally absent from CODEX_MODES; if a pre-existing room
      // still carries it, fall back to the safe read-only sandbox.
      default:
        return ['--sandbox', 'read-only', '-c', 'approval_policy=never'];
    }
  }
  return [];
};
