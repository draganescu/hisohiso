import { RoomCard } from 'hisohiso-app';

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

// Full /rooms card: large avatar, name, chat badge, preview line.
export const ChatCard = () => (
  <div style={frame}>
    <RoomCard room={chat} href="#" onRename={() => {}} onForget={() => {}} />
  </div>
);

// Control card: pink accent kind badge, daemon hostname handle.
export const ControlCard = () => (
  <div style={frame}>
    <RoomCard room={control} href="#" onRename={() => {}} onForget={() => {}} />
  </div>
);

// Agent card highlighted as the currently-open room (rail "current" treatment).
export const CurrentAgentCard = () => (
  <div style={frame}>
    <RoomCard
      room={agent}
      href="#"
      isCurrent
      onRename={() => {}}
      onForget={() => {}}
    />
  </div>
);
