// Convenience presets for agent rooms: short, tappable command strings the
// operator can fire at an agent without retyping the common ones. This module
// is pure data + types — no UI, no network, no server contract. A preset's
// `command` is just plain text; the caller decides whether to send it as a
// normal encrypted chat message or stage it into the agent batch. Nothing here
// touches identity, presence, or the wire format, so it stays privacy-neutral.

/** A single tappable preset. `id` is stable for keys/dedupe; `command` is the
 *  literal text that will be sent as an ordinary encrypted message. `label` is
 *  the short caption shown on the control; `hint` is optional help text. */
export type AgentQuickAction = {
  /** Stable, local-only identifier (used for React keys / dedupe). */
  readonly id: string;
  /** Short caption for the tappable control. */
  readonly label: string;
  /** Literal message text the preset sends — a normal chat line, nothing special. */
  readonly command: string;
  /** Optional one-line description of what the preset asks the agent to do. */
  readonly hint?: string;
};

/** The full preset list, in display order. Static and frozen — these are
 *  client-side conveniences, not configuration. */
export const AGENT_QUICK_ACTIONS: readonly AgentQuickAction[] = [
  {
    id: 'run-tests',
    label: 'Run tests',
    command: 'run the tests',
    hint: 'Run the test suite and report the results.',
  },
  {
    id: 'show-diff',
    label: 'Show diff',
    command: 'show me the diff',
    hint: 'Print the current working-tree diff.',
  },
  {
    id: 'explain-risk',
    label: 'Explain risk',
    command: 'explain the risk',
    hint: 'Call out anything risky or surprising in the current change.',
  },
  {
    id: 'open-pr',
    label: 'Open a PR',
    command: 'open a PR instead',
    hint: 'Open a pull request rather than committing directly.',
  },
  {
    id: 'summarize-changes',
    label: 'Summarize',
    command: 'summarize the changes so far',
    hint: 'Give a short summary of what has changed in this session.',
  },
  {
    id: 'undo-last',
    label: 'Undo last',
    command: 'undo the last change',
    hint: 'Revert the most recent change.',
  },
] as const;

/** Look up a preset by its stable id. Returns `undefined` if none matches. */
export const findQuickAction = (id: string): AgentQuickAction | undefined =>
  AGENT_QUICK_ACTIONS.find((action) => action.id === id);
