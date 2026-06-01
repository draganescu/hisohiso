// Sticky bottom command bar shown only in control rooms. Replaces the FAB
// and per-message Reply (both gated out for control rooms by RoomController)
// with the two operator actions the daemon actually accepts on its control-
// room surface:
//
//   - Spawn  → block_response value `show-launcher`. Daemon replies with the
//              agent picker (same one the welcome message shows).
//   - Agents → block_response value `show-list`. Daemon replies with the
//              running-agents list (each row carries Join/Kill buttons that
//              the daemon also handles via block_response).
//
// The N badge on Agents is a local count from listRooms().filter(kind ===
// 'agent') — instant, no daemon round-trip. Spawn is flush-left as primary
// (the more frequent action); Agents is flush-right as a chip (glanceable
// status with a live count). No third "message" button because the daemon
// takes no arbitrary instructions on the control room — every verb it
// accepts is reachable through these two and their downstream blocks.
import type { FC } from 'react';

type Props = {
  agentCount: number;
  onSpawn: () => void;
  onAgents: () => void;
};

export const ControlCommandBar: FC<Props> = ({ agentCount, onSpawn, onAgents }) => {
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
    </div>
  );
};
