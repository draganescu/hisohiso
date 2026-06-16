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
// The N badge on Agents is daemon-reported truth: the daemon stamps
// `agent_count` on every control-room envelope (welcome / list / spawn /
// kill / re-pair), so spawn and kill events both move it in lockstep. While
// no daemon message has arrived yet (`agentCount === null`), the badge is
// hidden rather than showing a misleading zero — the chip is still tappable
// and a tap will trigger the daemon to reply with a list that re-hydrates
// the count. Spawn is flush-left as primary (the more frequent action);
// Agents is flush-right as a chip.
import type { FC } from 'react';

type Props = {
  agentCount: number | null;
  onSpawn: () => void;
  onAgents: () => void;
};

export const ControlCommandBar: FC<Props> = ({ agentCount, onSpawn, onAgents }) => {
  return (
    <div className="command-bar" role="toolbar" aria-label="control room actions">
      <button
        type="button"
        className="command-bar-primary"
        onClick={onSpawn}
        aria-label="spawn an agent"
      >
        <span aria-hidden="true">+</span>
        <span>spawn</span>
      </button>
      <button
        type="button"
        className="command-bar-chip"
        onClick={onAgents}
        aria-label={agentCount === null ? 'running agents' : `running agents (${agentCount})`}
      >
        <span>agents</span>
        {agentCount !== null && <span className="command-bar-chip-badge">{agentCount}</span>}
      </button>
    </div>
  );
};
