export const tokenKey = (roomHash: string): string => `cfa.token.${roomHash}`;

export const getToken = (roomHash: string): string | null => {
  return localStorage.getItem(tokenKey(roomHash));
};

export const setToken = (roomHash: string, token: string): void => {
  localStorage.setItem(tokenKey(roomHash), token);
};

export const clearToken = (roomHash: string): void => {
  localStorage.removeItem(tokenKey(roomHash));
};

const handleKey = (roomHash: string): string => `cfa.handle.${roomHash}`;

export const getHandle = (roomHash: string): string | null => {
  return localStorage.getItem(handleKey(roomHash));
};

export const setHandle = (roomHash: string, handle: string): void => {
  localStorage.setItem(handleKey(roomHash), handle);
};

export const clearHandle = (roomHash: string): void => {
  localStorage.removeItem(handleKey(roomHash));
};

const roomPasswordKey = (roomHash: string): string => `cfa.room_password.${roomHash}`;

export const getRoomPassword = (roomHash: string): string | null => {
  return localStorage.getItem(roomPasswordKey(roomHash));
};

export const setRoomPassword = (roomHash: string, password: string): void => {
  localStorage.setItem(roomPasswordKey(roomHash), password);
};

export const clearRoomPassword = (roomHash: string): void => {
  localStorage.removeItem(roomPasswordKey(roomHash));
};

export type StoredRoom = {
  roomHash: string;
  roomSecret: string;
  lastSeen: number;
  handle?: string | null;
};

const roomsKey = 'cfa.rooms';

const readRooms = (): StoredRoom[] => {
  const raw = localStorage.getItem(roomsKey);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as StoredRoom[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeRooms = (rooms: StoredRoom[]): void => {
  localStorage.setItem(roomsKey, JSON.stringify(rooms));
};

export const upsertRoom = (roomHash: string, roomSecret: string, handle?: string | null): void => {
  const rooms = readRooms();
  const now = Math.floor(Date.now() / 1000);
  const existing = rooms.find((room) => room.roomHash === roomHash);
  if (existing) {
    existing.lastSeen = now;
    existing.roomSecret = roomSecret;
    if (typeof handle === 'string') {
      existing.handle = handle;
    }
  } else {
    rooms.push({
      roomHash,
      roomSecret,
      lastSeen: now,
      handle: typeof handle === 'string' ? handle : null
    });
  }
  rooms.sort((a, b) => b.lastSeen - a.lastSeen);
  writeRooms(rooms);
};

export const listRooms = (): StoredRoom[] => {
  const rooms = readRooms();
  return rooms.sort((a, b) => b.lastSeen - a.lastSeen);
};

export const removeRoom = (roomHash: string): void => {
  const rooms = readRooms().filter((room) => room.roomHash !== roomHash);
  writeRooms(rooms);
};

export const updateRoomHandle = (roomHash: string, handle: string): void => {
  const rooms = readRooms();
  const existing = rooms.find((room) => room.roomHash === roomHash);
  if (existing) {
    existing.handle = handle;
    existing.lastSeen = Math.floor(Date.now() / 1000);
    writeRooms(rooms);
  }
};
