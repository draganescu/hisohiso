// Cluster the operator surface (control + agent rooms) so each daemon's control
// room owns the agents it spawned. An agent room learns its parent control
// room hash when the operator taps "Join" from inside that control room (see
// joinActionRoom + StoredRoom.controlRoomHash). Agents minted before that link
// existed — or whose control room has since been forgotten — fall through to
// `orphanAgents` so they still surface, just ungrouped.
//
// One implementation, two consumers: the /rooms channels list and the in-room
// Switch-channels modal both render from these groups, so the agent → daemon
// hierarchy reads the same in both places.
import type { StoredRoom } from './storage';

export type ControlGroup = {
  control: StoredRoom;
  agents: StoredRoom[];
};

export type OpenChannelGroups = {
  /** One per control room (daemon), each carrying the agents it controls. */
  groups: ControlGroup[];
  /** Agent rooms with no known / no longer present control room. */
  orphanAgents: StoredRoom[];
  /** True when there is anything to show in the "Open channels" region. */
  hasAny: boolean;
};

export const groupOpenChannels = (rooms: StoredRoom[]): OpenChannelGroups => {
  // Input is already lastSeen-sorted by listRooms, so groups and the agents
  // within them inherit that ordering for free.
  const controls = rooms.filter((r) => r.kind === 'control');
  const agents = rooms.filter((r) => r.kind === 'agent');
  const knownControl = new Set(controls.map((c) => c.roomHash));

  const groups: ControlGroup[] = controls.map((control) => ({
    control,
    agents: agents.filter((a) => a.controlRoomHash === control.roomHash),
  }));

  const orphanAgents = agents.filter(
    (a) => !a.controlRoomHash || !knownControl.has(a.controlRoomHash)
  );

  return { groups, orphanAgents, hasAny: groups.length > 0 || orphanAgents.length > 0 };
};
