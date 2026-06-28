import { RoomRow } from 'hisohiso-app';

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

const chat: StoredRoom = {
  roomHash: 'a1f3c2',
  roomSecret: 'sek-a1f3c2',
  lastSeen: 1718900000000,
  kind: 'chat',
  nickname: 'weeknight planning',
  handle: 'alex',
  color: '#e85d75',
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

const agent: StoredRoom = {
  roomHash: 'c3d5e6',
  roomSecret: 'sek-c3d5e6',
  lastSeen: 1718880000000,
  kind: 'agent',
  nickname: 'fix flaky test',
  handle: 'fix-flaky-test',
  controlRoomHash: 'b2e4d1',
  color: '#f29e4c',
};

// Default link row (the /rooms list shape) — chat tone badge + handle subline.
export const ChatRow = () => (
  <div style={frame}>
    <RoomRow room={chat} href="#" joinedLabel="Joined" />
  </div>
);

// Control room: pink accent badge, daemon hostname as the handle.
export const ControlRow = () => (
  <div style={frame}>
    <RoomRow room={control} href="#" joinedLabel="Joined" />
  </div>
);

// Agent room: tang riso-ink badge, task-name handle.
export const AgentRow = () => (
  <div style={frame}>
    <RoomRow room={agent} href="#" joinedLabel="Link saved" />
  </div>
);

// Current-row state (switcher consumer): filled highlight + kebab menu.
export const CurrentRow = () => (
  <div style={frame}>
    <RoomRow
      room={chat}
      onSelect={() => {}}
      isCurrent
      onRename={() => {}}
      onForget={() => {}}
    />
  </div>
);
