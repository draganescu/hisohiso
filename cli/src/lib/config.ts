import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.hisohiso');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const REGISTRY_FILE = join(CONFIG_DIR, 'registry.json');
const ROOMS_FILE = join(CONFIG_DIR, 'rooms.json');
const PID_FILE = join(CONFIG_DIR, 'daemon.pid');
const LOGS_DIR = join(CONFIG_DIR, 'logs');

const DEFAULT_SERVER = 'https://hisohiso.org';

export { CONFIG_DIR, CONFIG_FILE, REGISTRY_FILE, ROOMS_FILE, PID_FILE, LOGS_DIR, DEFAULT_SERVER };

export type Config = {
  server: string;
};

export type DaemonState = {
  controlRoomSecret: string;
  controlRoomHash: string;
  participantToken: string;
  // Subscriber JWT used to re-attach SSE to the control room after a daemon
  // restart. Expires per server policy (PARTICIPANT_JWT_TTL); on expiry the
  // daemon needs to re-pair.
  subscriberJwt: string;
  controlRoomPassword: string;
};

export type RegisteredAgent = {
  name: string;
  command: string;
  mode: string;
};

export type ActiveRoom = {
  agentId: string;
  name: string;
  roomHash: string;
  roomSecret: string;
  // Server-side identity for this device in the room — needed to re-attach SSE,
  // resume presence, and approve future knocks after a daemon restart.
  participantToken: string;
  // Mercure subscriber JWT scoped to room:{roomHash}. Required to re-subscribe
  // after restart; if it has expired (or absent on a daemon upgraded across
  // protocol versions) the room is dropped during restore().
  subscriberJwt: string;
  // LLM-provider session handle (Claude session_id / Codex thread_id). Persisted so
  // a restarted daemon can continue the conversation via --resume / exec resume.
  // null until the first turn completes for session-mode agents; always null for oneshot.
  sessionId: string | null;
  pid: number;
};

export const ensureConfigDir = async (): Promise<void> => {
  await mkdir(CONFIG_DIR, { recursive: true });
  await mkdir(LOGS_DIR, { recursive: true });
};

export const getServer = async (): Promise<string> => {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(raw) as Config;
    return config.server || DEFAULT_SERVER;
  } catch {
    return DEFAULT_SERVER;
  }
};

export const saveConfig = async (config: Config): Promise<void> => {
  await ensureConfigDir();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
};

const DAEMON_STATE_FILE = join(CONFIG_DIR, 'daemon-state.json');

export const loadDaemonState = async (): Promise<DaemonState> => {
  const raw = await readFile(DAEMON_STATE_FILE, 'utf-8');
  return JSON.parse(raw) as DaemonState;
};

export const saveDaemonState = async (state: DaemonState): Promise<void> => {
  await ensureConfigDir();
  await writeFile(DAEMON_STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf-8');
};

export const loadRegistry = async (): Promise<RegisteredAgent[]> => {
  try {
    const raw = await readFile(REGISTRY_FILE, 'utf-8');
    return JSON.parse(raw) as RegisteredAgent[];
  } catch {
    return [];
  }
};

export const saveRegistry = async (agents: RegisteredAgent[]): Promise<void> => {
  await ensureConfigDir();
  await writeFile(REGISTRY_FILE, JSON.stringify(agents, null, 2) + '\n', 'utf-8');
};

export const loadActiveRooms = async (): Promise<ActiveRoom[]> => {
  try {
    const raw = await readFile(ROOMS_FILE, 'utf-8');
    return JSON.parse(raw) as ActiveRoom[];
  } catch {
    return [];
  }
};

export const saveActiveRooms = async (rooms: ActiveRoom[]): Promise<void> => {
  await ensureConfigDir();
  await writeFile(ROOMS_FILE, JSON.stringify(rooms, null, 2) + '\n', 'utf-8');
};

// Best-effort delete of the persisted daemon state + rooms files. Used by
// `daemon start --fresh` to force a new control room (and therefore a new QR).
export const clearDaemonState = async (): Promise<void> => {
  await unlink(DAEMON_STATE_FILE).catch(() => {});
};

export const clearActiveRooms = async (): Promise<void> => {
  await unlink(ROOMS_FILE).catch(() => {});
};
