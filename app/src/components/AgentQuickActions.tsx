// Horizontally-scrollable quick-action chip bar, shown ONLY in agent rooms,
// pinned just above the composer FAB / dispatch button. Each chip is a static,
// client-side convenience: tapping one fires a preset string through the room's
// EXISTING send/batch path (RoomController.sendQuickAction) — there is no new
// network call, no new message type, and nothing leaves that the composer
// wouldn't already send. Presets are pure data from lib/agent-quick-actions.
import type { FC } from 'react';
import { AGENT_QUICK_ACTIONS } from '../lib/agent-quick-actions';

type Props = {
  // Whether a batch is pending. Purely cosmetic here — it lifts the bar so it
  // clears the taller dispatch button — the send/batch decision itself lives in
  // RoomController (mirrors the composer's reply-vs-send choice).
  batchPending: boolean;
  onAction: (command: string) => void;
};

export const AgentQuickActions: FC<Props> = ({ batchPending, onAction }) => {
  return (
    <div
      className={`agent-quick-actions${batchPending ? ' agent-quick-actions-raised' : ''}`}
      role="toolbar"
      aria-label="quick actions"
    >
      <div className="agent-quick-actions-track">
        {AGENT_QUICK_ACTIONS.map((action) => (
          <button
            key={action.id}
            type="button"
            className="agent-quick-action-chip"
            onClick={() => onAction(action.command)}
            title={action.hint ?? action.label}
            aria-label={action.hint ?? action.label}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
};

export default AgentQuickActions;
