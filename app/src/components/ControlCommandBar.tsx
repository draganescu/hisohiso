// Sticky bottom command bar shown only in control rooms. Replaces the FAB +
// per-message Reply (both gated out for control rooms by RoomController) with
// the three operator actions the daemon actually accepts on its control-room
// surface:
//
//   - Spawn → block_response value `show-launcher`. Daemon replies with the
//     agent picker (the same one the welcome message shows).
//   - Agents → block_response value `show-list`. Daemon replies with the
//     running-agents list. The N badge is a local count from listRooms()
//     filtered to kind === 'agent' — instant, no round-trip.
//   - Message… → opens the existing full-screen modal composer. Deliberately
//     NOT a real inline <input>: an at-bottom focusable control fights the
//     iOS soft keyboard, which is exactly why the modal composer exists.
//
// Block IDs are stable strings so the same response payload re-emits cleanly
// if the user re-taps; the daemon doesn't dedupe on block_id anyway.
import type { FC } from 'react';

type Props = {
  agentCount: number;
  onSpawn: () => void;
  onAgents: () => void;
  onMessage: () => void;
};

export const ControlCommandBar: FC<Props> = ({ agentCount, onSpawn, onAgents, onMessage }) => {
  return (
    <div className="command-bar" role="toolbar" aria-label="Control room actions">
      <button
        type="button"
        className="command-bar-primary"
        onClick={onSpawn}
        aria-label="Spawn an agent"
      >
        <span aria-hidden="true">+</span>
        <span>Spawn</span>
      </button>
      <button
        type="button"
        className="command-bar-chip"
        onClick={onAgents}
        aria-label={`Running agents (${agentCount})`}
      >
        <span>Agents</span>
        <span className="command-bar-chip-badge">{agentCount}</span>
      </button>
      <button
        type="button"
        className="command-bar-input"
        onClick={onMessage}
        aria-label="Open message composer"
      >
        Message…
      </button>
    </div>
  );
};
