// `hisohiso info` (#137) — one no-flags command that prints the whole daemon
// picture on one screen, and stays truthful when the daemon is DOWN (that's
// exactly when you need to know where everything lives). Reads three sources,
// degrading gracefully if any is absent:
//   1. filesystem            (always available)
//   2. service manager       (#125 getServiceInfo — launchd now)
//   3. the live daemon       (#134 control socket `status` op)
//
// `--json` is the only flag, for scripting.

import { stat } from 'node:fs/promises';
import {
  CONFIG_DIR,
  CONFIG_FILE,
  REGISTRY_FILE,
  ROOMS_FILE,
  PID_FILE,
  LOGS_DIR,
  SOCKET_FILE,
  getServer,
  loadDaemonState,
  loadActiveRooms,
  loadRegistry,
} from '../lib/config.js';
import { join } from 'node:path';
import { isDaemonRunning, readPid } from '../daemon/pid.js';
import { resolveExecPath } from '../lib/updater.js';
import { getServiceInfo } from '../lib/service.js';
import { sendControlRequest, DaemonUnreachableError, type StatusResult } from '../lib/control-plane.js';
import pkg from '../../package.json' with { type: 'json' };

const PRESENCE_INTERVAL_MS = 20_000; // mirrors presence.ts
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // mirrors daemon-main reconcile timer
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // mirrors updater DEFAULT_INTERVAL_MS

type FileFact = { exists: boolean; size: number };

const fileFact = async (path: string): Promise<FileFact> => {
  try {
    const s = await stat(path);
    return { exists: true, size: s.size };
  } catch {
    return { exists: false, size: 0 };
  }
};

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const fmtUptime = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
};

// Reachable = the server answered an HTTP request at all (even a 404). Network
// error / timeout = unreachable. Short timeout so `info` never hangs.
const probeServer = async (server: string): Promise<boolean> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    await fetch(server, { method: 'HEAD', signal: ctrl.signal });
    return true;
  } catch {
    try {
      await fetch(server, { method: 'GET', signal: ctrl.signal });
      return true;
    } catch {
      return false;
    }
  } finally {
    clearTimeout(timer);
  }
};

type InfoModel = {
  version: string;
  binary: string;
  autoUpdate: boolean;
  home: string;
  homeOverridden: boolean;
  server: string;
  serverReachable: boolean;
  files: {
    config: FileFact;
    pairing: FileFact & { paired: boolean | null };
    rooms: FileFact & { count: number };
    registry: FileFact & { count: number };
    pid: FileFact & { pid: number | null; alive: boolean };
    socket: FileFact;
    log: FileFact;
  };
  daemon: { running: boolean; status: StatusResult | null };
  service: Awaited<ReturnType<typeof getServiceInfo>>;
};

const gather = async (): Promise<InfoModel> => {
  const server = await getServer();

  const [state, rooms, registry, pid] = await Promise.all([
    loadDaemonState().catch(() => null),
    loadActiveRooms().catch(() => []),
    loadRegistry().catch(() => []),
    readPid(),
  ]);

  const [configF, pairingF, roomsF, registryF, pidF, socketF, logF, reachable, alive, service] =
    await Promise.all([
      fileFact(CONFIG_FILE),
      fileFact(join(CONFIG_DIR, 'daemon-state.json')),
      fileFact(ROOMS_FILE),
      fileFact(REGISTRY_FILE),
      fileFact(PID_FILE),
      fileFact(SOCKET_FILE),
      fileFact(join(LOGS_DIR, 'daemon.log')),
      probeServer(server),
      isDaemonRunning(),
      getServiceInfo(),
    ]);

  // Live runtime rows over the control socket; absent => daemon not running.
  let status: StatusResult | null = null;
  try {
    status = await sendControlRequest<StatusResult>({ op: 'status' }, 2000);
  } catch (err) {
    if (!(err instanceof DaemonUnreachableError)) throw err;
  }

  return {
    version: pkg.version,
    binary: resolveExecPath(),
    autoUpdate: process.env.HISOHISO_AUTO_UPDATE !== 'off',
    home: CONFIG_DIR,
    homeOverridden: Boolean(process.env.HISOHISO_HOME),
    server,
    serverReachable: reachable,
    files: {
      config: configF,
      pairing: { ...pairingF, paired: state ? state.controlBound === true : null },
      rooms: { ...roomsF, count: rooms.length },
      registry: { ...registryF, count: registry.length },
      pid: { ...pidF, pid, alive },
      socket: socketF,
      log: logF,
    },
    daemon: { running: status !== null, status },
    service,
  };
};

const render = (m: InfoModel): string => {
  const lines: string[] = [];
  const yes = '✓';
  const no = '✗';

  lines.push(`hisohiso ${m.version}    ${m.binary}`);
  lines.push(`auto-update: ${m.autoUpdate ? 'on' : 'off'}    →  github.com/draganescu/hisohiso`);
  lines.push('');

  lines.push(`Home        ${m.home}${m.homeOverridden ? '   (HISOHISO_HOME)' : ''}`);
  lines.push(
    `  config      config.json        ${m.files.config.exists ? `server = ${m.server}   (${m.serverReachable ? `reachable ${yes}` : `unreachable ${no}`})` : 'absent'}`
  );
  lines.push(
    `  pairing     daemon-state.json  ${
      m.files.pairing.exists
        ? m.files.pairing.paired
          ? 'control room paired'
          : 'awaiting pairing'
        : 'not paired yet'
    }`
  );
  lines.push(`  rooms       rooms.json         ${m.files.rooms.exists ? `${m.files.rooms.count} active agent room(s)` : 'none'}`);
  lines.push(`  registry    registry.json      ${m.files.registry.exists ? `${m.files.registry.count} custom agent(s)` : 'none'}`);
  lines.push(
    `  pid         daemon.pid         ${
      m.files.pid.exists ? `PID ${m.files.pid.pid}${m.files.pid.alive ? '' : ' (stale — no process)'}` : 'absent'
    }`
  );
  lines.push(`  socket      daemon.sock        ${m.files.socket.exists ? `listening ${yes}` : 'absent'}`);
  lines.push(`  logs        logs/daemon.log    ${m.files.log.exists ? fmtBytes(m.files.log.size) : 'absent'}`);
  lines.push('');

  if (m.daemon.running && m.daemon.status) {
    const s = m.daemon.status;
    lines.push(`Daemon       running · up ${fmtUptime(s.uptimeMs)} · v${s.version}`);
    lines.push(`  control     ${s.controlRoomHash.slice(0, 12)}… · ${s.paired ? 'paired' : 'awaiting pairing'}`);
    if (s.agents.length === 0) {
      lines.push('  agents      none running');
    } else {
      for (const a of s.agents) lines.push(`  agent       ${a.name.padEnd(10)} ${a.agentId}`);
    }
    if (s.pendingDevices.length > 0) {
      lines.push(`  devices     ${s.pendingDevices.length} awaiting admission — run \`hisohiso admit\``);
    }
  } else {
    lines.push('Daemon       not running');
  }
  lines.push('');

  if (m.service.supported && m.service.manager === 'launchd') {
    lines.push(`Managed by   launchd (LaunchAgent)`);
    lines.push(`  unit        ${m.service.unitPath}`);
    lines.push(`  state       ${m.service.installed ? 'installed' : 'not installed'}${m.service.loaded ? ` · loaded ${yes}` : m.service.installed ? ` · not loaded ${no}` : ''}`);
  } else if (m.service.platform === 'linux') {
    lines.push(`Managed by   systemd user unit (support lands in the next #125 PR)`);
  } else {
    lines.push(`Managed by   no supported service manager on ${m.service.platform}`);
  }
  lines.push('');

  lines.push(
    `Heartbeat    presence: ${PRESENCE_INTERVAL_MS / 1000}s · reconcile: ${RECONCILE_INTERVAL_MS / 60000}m · update tick: ${UPDATE_INTERVAL_MS / 3600000}h`
  );

  return lines.join('\n');
};

export const info = async (opts: { json?: boolean } = {}): Promise<void> => {
  const model = await gather();
  if (opts.json) {
    console.log(JSON.stringify(model, null, 2));
    return;
  }
  console.log(render(model));
};
