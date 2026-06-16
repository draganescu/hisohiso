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

const expectedKnockMessageKey = (roomHash: string): string => `hisohiso.expected_knock.${roomHash}`;

export const getExpectedKnockMessage = (roomHash: string): string | null => {
  return localStorage.getItem(expectedKnockMessageKey(roomHash));
};

export const setExpectedKnockMessage = (roomHash: string, message: string): void => {
  const trimmed = message.trim();
  if (trimmed) {
    localStorage.setItem(expectedKnockMessageKey(roomHash), trimmed);
  } else {
    localStorage.removeItem(expectedKnockMessageKey(roomHash));
  }
};

export const clearExpectedKnockMessage = (roomHash: string): void => {
  localStorage.removeItem(expectedKnockMessageKey(roomHash));
};

const roomSetupDismissedKey = (roomHash: string): string => `hisohiso.room_setup_dismissed.${roomHash}`;

export const getRoomSetupDismissed = (roomHash: string): boolean => {
  return localStorage.getItem(roomSetupDismissedKey(roomHash)) === '1';
};

export const setRoomSetupDismissed = (roomHash: string, dismissed: boolean): void => {
  if (dismissed) {
    localStorage.setItem(roomSetupDismissedKey(roomHash), '1');
  } else {
    localStorage.removeItem(roomSetupDismissedKey(roomHash));
  }
};

export const clearRoomSetupDismissed = (roomHash: string): void => {
  localStorage.removeItem(roomSetupDismissedKey(roomHash));
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

// In-app navigation here is a real full page load (we move between screens with
// window.location / <a href>, not client-side routing). That unload fires the
// same visibilitychange/pagehide events as sending the app to the background,
// so the suspend lock can't tell the two apart and used to wipe the session
// unlock mid-navigation — booting the next screen locked. We drop a short-lived
// marker right before an intentional navigation; the suspend controller treats
// a hide as a real backgrounding only when no fresh marker is present. The
// marker is a timestamp so a stray set (a click that never navigates) can only
// suppress locking briefly, never indefinitely.
const APP_NAV_INTENT_KEY = 'hisohiso.app_nav_intent';
const NAV_INTENT_MAX_AGE_MS = 5_000;

export const markInAppNavigation = (): void => {
  try {
    sessionStorage.setItem(APP_NAV_INTENT_KEY, String(Date.now()));
  } catch {
    // sessionStorage unavailable: fall back to prior behaviour (may re-lock on
    // navigation) — never less secure.
  }
};

export const isInAppNavigationPending = (maxAgeMs: number = NAV_INTENT_MAX_AGE_MS): boolean => {
  try {
    const raw = sessionStorage.getItem(APP_NAV_INTENT_KEY);
    if (!raw) return false;
    const at = Number(raw);
    return Number.isFinite(at) && Date.now() - at <= maxAgeMs;
  } catch {
    return false;
  }
};

export const clearInAppNavigation = (): void => {
  try {
    sessionStorage.removeItem(APP_NAV_INTENT_KEY);
  } catch {
    // ignore
  }
};

// Every room is exactly one kind, assigned at creation by whoever mints it:
// the PWA stamps plain peer rooms as 'chat'; the daemon stamps its own room
// 'control' and spawned agent rooms 'agent'. The discriminator rides inside the
// encrypted message envelope, so the relay never learns it. Required — there is
// no unset state once readRooms() has run its backfill.
export type RoomKind = 'chat' | 'control' | 'agent';

export const isRoomKind = (value: unknown): value is RoomKind =>
  value === 'chat' || value === 'control' || value === 'agent';

export type StoredRoom = {
  roomHash: string;
  roomSecret: string;
  lastSeen: number;
  kind: RoomKind;
  handle?: string | null;
  nickname?: string | null;
  color?: string;
  // For 'agent' rooms: the roomHash of the control room (daemon) that spawned
  // it. Learned when the operator taps "Join" from inside that control room —
  // see joinActionRoom. Lets the channels list group each agent under the
  // daemon that controls it. Absent on chat/control rooms, and on agent rooms
  // joined before this link existed (they surface as "control unknown" until
  // re-joined from a control room).
  controlRoomHash?: string | null;
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
    if (!Array.isArray(parsed)) return [];
    // One-time backfill: rooms persisted before `kind` existed default to
    // 'chat' so the field is never absent downstream. Writes back lazily via
    // the callers that already persist (upsert/list), so a read alone is pure.
    for (const room of parsed) {
      if (!isRoomKind(room.kind)) room.kind = 'chat';
    }
    return parsed;
  } catch {
    return [];
  }
};

const writeRooms = (rooms: StoredRoom[]): void => {
  localStorage.setItem(roomsKey, JSON.stringify(rooms));
};

export const upsertRoom = (
  roomHash: string,
  roomSecret: string,
  handle?: string | null,
  kind?: RoomKind,
  controlRoomHash?: string | null
): void => {
  const rooms = readRooms();
  const now = Math.floor(Date.now() / 1000);
  const existing = rooms.find((room) => room.roomHash === roomHash);
  if (existing) {
    existing.lastSeen = now;
    existing.roomSecret = roomSecret;
    if (typeof handle === 'string') {
      existing.handle = handle;
    }
    // A room's kind is learned once and only ever sharpened away from the
    // 'chat' default — a daemon stamp ('control'/'agent') wins, but we never
    // downgrade a known kind back to 'chat' on a later plain upsert.
    if (kind && kind !== 'chat') {
      existing.kind = kind;
    }
    // Same sharpen-once rule for the parent control link: learn it on the
    // first Join from a control room, but a later orphan upsert (no parent
    // known) never clears an established link.
    if (controlRoomHash && !existing.controlRoomHash) {
      existing.controlRoomHash = controlRoomHash;
    }
  } else {
    rooms.push({
      roomHash,
      roomSecret,
      lastSeen: now,
      kind: kind ?? 'chat',
      handle: typeof handle === 'string' ? handle : null,
      color: generatePastelColor(),
      controlRoomHash: controlRoomHash ?? null
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

export const getRoomKind = (roomHash: string): RoomKind => {
  const rooms = readRooms();
  const existing = rooms.find((room) => room.roomHash === roomHash);
  return existing?.kind ?? 'chat';
};

// Persist a kind learned from a daemon message envelope. Mirrors upsertRoom's
// rule: only sharpens away from 'chat', never downgrades a known kind.
export const setRoomKind = (roomHash: string, kind: RoomKind): void => {
  if (kind === 'chat') return;
  const rooms = readRooms();
  const existing = rooms.find((room) => room.roomHash === roomHash);
  if (existing && existing.kind !== kind) {
    existing.kind = kind;
    writeRooms(rooms);
  }
};
