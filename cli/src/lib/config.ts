import { readFile, writeFile, mkdir, access, unlink, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Schedule } from './scheduler.js';

// State directory. Defaults to ~/.hisohiso, but HISOHISO_HOME overrides it so a
// second (e.g. worktree / dev) daemon can run with isolated config + PID + rooms
// state alongside the production daemon, without colliding on ~/.hisohiso.
const CONFIG_DIR = process.env.HISOHISO_HOME || join(homedir(), '.hisohiso');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const REGISTRY_FILE = join(CONFIG_DIR, 'registry.json');
const ROOMS_FILE = join(CONFIG_DIR, 'rooms.json');
const SCHEDULES_FILE = join(CONFIG_DIR, 'schedules.json');
const PID_FILE = join(CONFIG_DIR, 'daemon.pid');
const LOGS_DIR = join(CONFIG_DIR, 'logs');
// Owner-only control socket (#134) — same local trust boundary as the PID file.
// The detached daemon listens here; CLI verbs (status/pair/admit) connect.
const SOCKET_FILE = join(CONFIG_DIR, 'daemon.sock');

// The apex serves the PWA + API; the static content site lives on a separate
// host at www.hisohiso.org. Self-hosters override this with
// `hisohiso server https://your-host`.
const DEFAULT_SERVER = 'https://hisohiso.org';

export { CONFIG_DIR, CONFIG_FILE, REGISTRY_FILE, ROOMS_FILE, PID_FILE, LOGS_DIR, SOCKET_FILE, DEFAULT_SERVER };

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
  // The operator's session knock message — set once at `hisohiso daemon start`,
  // reused as the expected knock-cleartext for the control room AND for every
  // agent room minted during this daemon's lifetime. Persisted so auto-update
  // re-execs don't lose it. Cleared by `daemon start --fresh`. The threat model
  // assumes this string is unguessable to anyone outside the operator's head.
  sessionKnockMessage: string;
  // First-device-wins binding flag for the control room. Set true once the
  // first device is auto-admitted; thereafter any additional knock is routed
  // to an explicit operator confirm instead of being auto-approved. Optional /
  // missing => false on disk so a daemon restarting on state written before
  // this field never crashes (tolerant reload) — legacy single-device pairings
  // stay unbound until their next additional knock flips the flag. Cleared by
  // `daemon start --fresh` (which deletes daemon-state.json). NOTE: this is a
  // pairing-window TOCTOU defense — a party already holding room_secret +
  // pairing-code + sessionKnockMessage can win the first-device race; this is
  // the ceiling without a stable phone-side device key.
  controlBound?: boolean;
  // The ephemeral knock pubkey of the device that bound the control room. A
  // retry from this same pubkey is the same first device missing the live-only
  // wrapped-token delivery race; the daemon should re-send the pass instead of
  // treating it as a new device. Optional / missing => safe default: no retry
  // fast path, so additional knocks still require explicit operator approval.
  controlBoundPubkey?: string;
  // KDF generation this control room was paired under (finding #93). Absent /
  // !== 1 means the room predates the PBKDF2 + high-entropy-code upgrade and was
  // paired with a weak 4-digit code; such state is NOT reused — the daemon
  // re-pairs to mint a fresh high-entropy code. Fresh pairs write 1.
  kdfVersion?: number;
};

export type RegisteredAgent = {
  name: string;
  command: string;
  mode: string;
  // Opt-in (finding #97): when true the daemon exports HISOHISO_ROOM_SECRET into
  // this agent's process env. Default/absent => withheld. Set via
  // `daemon register --needs-room-secret`.
  needsRoomSecret?: boolean;
};

export type ActiveRoom = {
  agentId: string;
  name: string;
  roomHash: string;
  roomSecret: string;
  // Per-agent-room 4-digit pairing code used as the room password (folded into
  // k_msg/k_knock). Broadcast to the operator via the control-room chat and
  // typed on the phone when joining. Distinct per room; persisted so a daemon
  // restart preserves the cryptographic identity of in-flight agent rooms.
  roomPassword: string;
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
  // First-device-wins binding flag for this agent room. Set true once the first
  // device's knock is auto-admitted; an additional knock thereafter is routed to
  // a control-room confirm instead of being auto-approved. Optional / missing =>
  // false on disk so restore() never crashes on a pre-#94 rooms.json (legacy
  // rooms stay unbound until their next knock flips it). Cleared by
  // `daemon start --fresh` (which deletes rooms.json).
  bound?: boolean;
  // The ephemeral knock pubkey of the device that bound this room (set alongside
  // `bound`). A later knock from THIS exact pubkey is the same device retrying —
  // its first wrapped-token can be lost to a live-only delivery race (the phone's
  // lobby SSE may not be open yet when the daemon replies), so it is re-approved
  // (the pass re-sent) rather than parked. A knock from any OTHER pubkey is still
  // treated as a new device and routed to a control-room confirm. Optional /
  // missing => no same-device fast path (every extra knock confirms), which is
  // the safe default for a pre-existing rooms.json.
  boundPubkey?: string;
  // Per-room replay ledger: msg_id -> local Date.now() first-seen ms. Persisted
  // so a daemon restart (or 6h auto-update re-exec) can't be made to re-execute
  // an outbox-retained turn the server re-publishes. Pruned to a 24h TTL on load
  // and save (mirroring server OUTBOX_TTL_MS). Optional / missing => empty ledger
  // so restore() never crashes on an old rooms.json.
  seenMsgIds?: Record<string, number>;
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

// Serialize writes so concurrent callers never overlap. persistRooms fires on
// every inbound chat (the seenMsgIds replay ledger) and on session-id updates,
// so two saves can run at once; with a single fixed temp path the first rename()
// consumes rooms.json.tmp and the second fails with ENOENT. Chaining each write
// onto the previous one keeps the fixed temp name safe. The chain stays
// resolvable even if a write throws (.catch), while each caller still awaits —
// and sees the error of — its own write.
let roomsWriteChain: Promise<void> = Promise.resolve();
export const saveActiveRooms = (rooms: ActiveRoom[]): Promise<void> => {
  const run = async (): Promise<void> => {
    await ensureConfigDir();
    // Atomic write: a bare writeFile could truncate rooms.json mid-write and lose
    // ALL restorable rooms on a crash. Write to a sibling temp file then rename()
    // over the target — rename is atomic on the same filesystem.
    const tmp = ROOMS_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(rooms, null, 2) + '\n', 'utf-8');
    await rename(tmp, ROOMS_FILE);
  };
  const result = roomsWriteChain.then(run, run);
  roomsWriteChain = result.catch(() => {});
  return result;
};

// Best-effort delete of the persisted daemon state + rooms files. Used by
// `daemon start --fresh` to force a new control room (and therefore a new QR).
export const clearDaemonState = async (): Promise<void> => {
  await unlink(DAEMON_STATE_FILE).catch(() => {});
};

export const clearActiveRooms = async (): Promise<void> => {
  await unlink(ROOMS_FILE).catch(() => {});
};

// --- scheduler (#232): persisted recurring schedules ---

// Tolerant load: a missing/corrupt file yields no schedules (the daemon just
// runs without any) rather than crashing the boot path.
export const loadSchedules = async (): Promise<Schedule[]> => {
  try {
    const raw = await readFile(SCHEDULES_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Schedule[]) : [];
  } catch {
    return [];
  }
};

// Atomic write, serialized like saveActiveRooms: the scheduler persists on every
// add/pause/remove and after each fire, so two writes can overlap; a fixed temp
// path + a write chain keeps the rename() safe.
let schedulesWriteChain: Promise<void> = Promise.resolve();
export const saveSchedules = (schedules: Schedule[]): Promise<void> => {
  const run = async (): Promise<void> => {
    await ensureConfigDir();
    const tmp = SCHEDULES_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(schedules, null, 2) + '\n', 'utf-8');
    await rename(tmp, SCHEDULES_FILE);
  };
  const result = schedulesWriteChain.then(run, run);
  schedulesWriteChain = result.catch(() => {});
  return result;
};

export const clearSchedules = async (): Promise<void> => {
  await unlink(SCHEDULES_FILE).catch(() => {});
};
