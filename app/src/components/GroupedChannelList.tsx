// The operator surface, rendered once for two consumers: the /rooms channels
// list and the in-room Switch-channels modal. Each control room (daemon) owns
// the agents it spawned — they hang off a connector rule beneath it — and any
// agent whose control room is unknown falls into a trailing "control unknown"
// section. The row chrome differs between the two call sites (an <a href> with a
// kebab menu on /rooms; an <button> with current-room highlight in the
// switcher), so the row renderer is injected via `renderRow` while the grouping
// hierarchy and its spacing live here, in one place, immune to drift.
import type { ReactNode } from 'react';
import type { ControlGroup } from '../lib/room-grouping';
import type { StoredRoom } from '../lib/storage';

// Single source of truth for the orphan-section heading, shared by both
// consumers so the label can't drift between them.
export const ORPHAN_AGENTS_LABEL = 'Agents · control unknown';

type Props = {
  groups: ControlGroup[];
  orphanAgents: StoredRoom[];
  renderRow: (room: StoredRoom) => ReactNode;
};

export const GroupedChannelList = ({ groups, orphanAgents, renderRow }: Props) => (
  <>
    {groups.map(({ control, agents }) => (
      <div key={control.roomHash} className="flex flex-col gap-1.5">
        {renderRow(control)}
        {agents.length > 0 && (
          // Agents indented under their control room with a connector rule, so
          // "whose control is this agent under" is read at a glance.
          <div className="ml-[1.4rem] flex flex-col gap-1.5 border-l border-rule pl-3">
            {agents.map(renderRow)}
          </div>
        )}
      </div>
    ))}
    {orphanAgents.length > 0 && (
      <div className="flex flex-col gap-1.5">
        <p className="px-1 text-[0.625rem] font-medium uppercase tracking-[0.28em] text-ink-dim">
          {ORPHAN_AGENTS_LABEL}
        </p>
        {orphanAgents.map(renderRow)}
      </div>
    )}
  </>
);
