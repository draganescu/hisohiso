export type RoomState = 'INIT' | 'LOBBY_WAITING' | 'LOBBY_EMPTY' | 'PARTICIPANT' | 'DESTROYED' | 'LEFT';

export type RoomEvent = {
  v: number;
  type: 'chat' | 'knock' | 'approve' | 'reject' | 'destroy' | 'settings' | 'token';
  room_hash: string;
  from?: string | null;
  ts: number;
  body: Record<string, unknown>;
};

export type KnockRequest = {
  id: string;
  msgId: string;
  pubkey: string;
  ts: number;
  message?: string | null;
};
