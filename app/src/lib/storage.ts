export const tokenKey = (roomHash: string): string => `hisohiso.token.${roomHash}`;

export const getToken = (roomHash: string): string | null => {
  return localStorage.getItem(tokenKey(roomHash));
};

export const setToken = (roomHash: string, token: string): void => {
  localStorage.setItem(tokenKey(roomHash), token);
};

export const clearToken = (roomHash: string): void => {
  localStorage.removeItem(tokenKey(roomHash));
};

const subJwtKey = (roomHash: string): string => `hisohiso.subjwt.${roomHash}`;

export const getSubscriberJwt = (roomHash: string): string | null => {
  return localStorage.getItem(subJwtKey(roomHash));
};

export const setSubscriberJwt = (roomHash: string, jwt: string): void => {
  localStorage.setItem(subJwtKey(roomHash), jwt);
};

export const clearSubscriberJwt = (roomHash: string): void => {
  localStorage.removeItem(subJwtKey(roomHash));
};

const handleKey = (roomHash: string): string => `hisohiso.handle.${roomHash}`;

export const getHandle = (roomHash: string): string | null => {
  return localStorage.getItem(handleKey(roomHash));
};

export const setHandle = (roomHash: string, handle: string): void => {
  localStorage.setItem(handleKey(roomHash), handle);
};

export const clearHandle = (roomHash: string): void => {
  localStorage.removeItem(handleKey(roomHash));
};

const roomPasswordKey = (roomHash: string): string => `hisohiso.room_password.${roomHash}`;

export const getRoomPassword = (roomHash: string): string | null => {
  return localStorage.getItem(roomPasswordKey(roomHash));
};

export const setRoomPassword = (roomHash: string, password: string): void => {
  localStorage.setItem(roomPasswordKey(roomHash), password);
};

export const clearRoomPassword = (roomHash: string): void => {
  localStorage.removeItem(roomPasswordKey(roomHash));
};

// --- App lock: a single GLOBAL setting (not per room). On by default, but it
// only actually engages once a PIN has been set — see isAppLockArmed. The
// passkey credential, when enrolled, lives separately in app-passkey.ts. ---

const APP_LOCK_KEY = 'hisohiso.app_lock';

export type AppLockPin = { salt: string; hash: string };

export type AppLockConfig = {
  enabled: boolean;
  pin?: AppLockPin;
};

export const getAppLockConfig = (): AppLockConfig => {
  try {
    const raw = localStorage.getItem(APP_LOCK_KEY);
    if (!raw) return { enabled: true };
    const parsed = JSON.parse(raw) as Partial<AppLockConfig>;
    return { enabled: parsed.enabled ?? true, pin: parsed.pin };
  } catch {
    return { enabled: true };
  }
};

export const setAppLockConfig = (config: AppLockConfig): void => {
  localStorage.setItem(APP_LOCK_KEY, JSON.stringify(config));
};

// Armed = the lock will actually engage: enabled by the user AND a PIN exists
// to verify against. Default-on with no PIN is "on but not yet protecting".
export const isAppLockArmed = (config: AppLockConfig = getAppLockConfig()): boolean => {
  return config.enabled && Boolean(config.pin);
};

// "Unlocked for this session" lives in sessionStorage — deliberately NOT
// localStorage. It survives in-app navigations (full page loads in this
// multi-page PWA) so a single unlock sticks while you move between rooms and
// the home screen, but it is gone when the PWA process is killed, so a fresh
// launch starts locked again.
const APP_UNLOCK_SESSION_KEY = 'hisohiso.app_unlocked';

export const isAppUnlockedForSession = (): boolean => {
  try {
    return sessionStorage.getItem(APP_UNLOCK_SESSION_KEY) === '1';
  } catch {
    return false;
  }
};

export const markAppUnlockedForSession = (): void => {
  try {
    sessionStorage.setItem(APP_UNLOCK_SESSION_KEY, '1');
  } catch {
    // sessionStorage unavailable (e.g. some private-mode quirks): fall back to
    // in-memory unlock only — the app still works, it just re-locks on reload.
  }
};

export const clearAppUnlockedForSession = (): void => {
  try {
    sessionStorage.removeItem(APP_UNLOCK_SESSION_KEY);
  } catch {
    // ignore
  }
};

export type StoredRoom = {
  roomHash: string;
  roomSecret: string;
  lastSeen: number;
  handle?: string | null;
  nickname?: string | null;
  color?: string;
};

const generatePastelColor = (): string => {
  const hue = Math.floor(Math.random() * 360);
  const saturation = 50 + Math.floor(Math.random() * 20); // 50-70%
  const lightness = 75 + Math.floor(Math.random() * 10); // 75-85%
  // Convert HSL to hex
  const h = hue / 360;
  const s = saturation / 100;
  const l = lightness / 100;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const g = Math.round(hue2rgb(p, q, h) * 255);
  const b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
};

const roomsKey = 'hisohiso.rooms';

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
      handle: typeof handle === 'string' ? handle : null,
      color: generatePastelColor()
    });
  }
  rooms.sort((a, b) => b.lastSeen - a.lastSeen);
  writeRooms(rooms);
};

export const listRooms = (): StoredRoom[] => {
  const rooms = readRooms();
  let dirty = false;
  for (const room of rooms) {
    if (!room.color) {
      room.color = generatePastelColor();
      dirty = true;
    }
  }
  if (dirty) {
    writeRooms(rooms);
  }
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

export const updateRoomNickname = (roomHash: string, nickname: string): void => {
  const rooms = readRooms();
  const existing = rooms.find((room) => room.roomHash === roomHash);
  if (existing) {
    existing.nickname = nickname || null;
    writeRooms(rooms);
  }
};

export const getRoomColor = (roomHash: string): string => {
  const rooms = readRooms();
  const existing = rooms.find((room) => room.roomHash === roomHash);
  if (existing) {
    if (!existing.color) {
      existing.color = generatePastelColor();
      writeRooms(rooms);
    }
    return existing.color;
  }
  return generatePastelColor();
};

export const getRoomNickname = (roomHash: string): string | null => {
  const rooms = readRooms();
  const existing = rooms.find((room) => room.roomHash === roomHash);
  return existing?.nickname ?? null;
};
