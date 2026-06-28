import { GroupedChannelList, RoomRow } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

type StoredRoom = {
  roomHash: string;
  roomSecret: string;
  lastSeen: number;
  kind: 'chat' | 'control' | 'agent';
  handle?: string | null;
  nickname?: string | null;
  color?: string;
  controlRoomHash?: string | null;
};

const control: StoredRoom = {
  roomHash: 'b2e4d1',
  roomSecret: 'sek-b2e4d1',
  lastSeen: 1718890000000,
  kind: 'control',
  nickname: null,
  handle: 'daemon · mbp-16',
  color: '#7b61ff',
};

const agentA: StoredRoom = {
  roomHash: 'c3d5e6',
  roomSecret: 'sek-c3d5e6',
  lastSeen: 1718880000000,
  kind: 'agent',
  nickname: 'fix flaky test',
  handle: 'fix-flaky-test',
  controlRoomHash: 'b2e4d1',
  color: '#f29e4c',
};

const agentB: StoredRoom = {
  roomHash: 'd4e6f7',
  roomSecret: 'sek-d4e6f7',
  lastSeen: 1718870000000,
  kind: 'agent',
  nickname: 'bump deps & rebuild',
  handle: 'bump-deps',
  controlRoomHash: 'b2e4d1',
  color: '#3aa99f',
};

const orphan: StoredRoom = {
  roomHash: 'e5f7a8',
  roomSecret: 'sek-e5f7a8',
  lastSeen: 1718860000000,
  kind: 'agent',
  nickname: 'audit logging',
  handle: 'audit-logging',
  controlRoomHash: null,
  color: '#c45ab3',
};

const renderRow = (room: StoredRoom) => <RoomRow room={room} href="#" />;

// One daemon owning two agent rooms, indented under it with a connector rule.
export const ControlWithAgents = () => (
  <div style={frame}>
    <GroupedChannelList
      groups={[{ control, agents: [agentA, agentB] }]}
      orphanAgents={[]}
      renderRow={renderRow}
    />
  </div>
);

// Daemon + agents plus a trailing "control unknown" orphan section.
export const WithOrphanAgents = () => (
  <div style={frame}>
    <GroupedChannelList
      groups={[{ control, agents: [agentA] }]}
      orphanAgents={[orphan]}
      renderRow={renderRow}
    />
  </div>
);
