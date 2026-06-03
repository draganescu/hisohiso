// Per-user background-service install for the always-on daemon (#125).
//
// Generates and loads the right service unit for the host so the daemon
// survives logout/reboot and restarts on crash, WITHOUT ever running as root.
// macOS (launchd LaunchAgent) is implemented here; Linux (systemd user unit)
// lands in the #125 follow-up. The daemon handles its own self-update re-exec
// (lib/updater.ts) by exec'ing over the same PID, so the service manager only
// owns crash/boot restarts — not updates.

import { execFile } from 'node:child_process';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { homedir, platform, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CONFIG_DIR, LOGS_DIR, loadDaemonState } from './config.js';
import { resolveExecPath } from './updater.js';

const execFileP = promisify(execFile);

// launchd LaunchAgent identity.
export const SERVICE_LABEL = 'org.hisohiso.daemon';

// Env flag the unit sets so the daemon (and #134's control plane) can tell it's
// running under a service manager with no controlling TTY — e.g. to enter an
// explicit awaiting-pairing state instead of printing a QR nobody can scan.
export const SERVICE_ENV_FLAG = 'HISOHISO_SERVICE';

const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, `${SERVICE_LABEL}.plist`);
const LOG_PATH = join(LOGS_DIR, 'daemon.log');

export type ServiceInfo = {
  platform: NodeJS.Platform;
  supported: boolean;
  manager: 'launchd' | 'systemd' | null;
  label: string;
  unitPath: string | null;
  installed: boolean;
  loaded: boolean;
};

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

// Hard gate: a root-owned daemon would wrap phone-driven agent processes
// (claude/codex/bash/python) at uid 0 — an unacceptable privilege level for a
// remotely-driven shell — and would scribble state into root's home + a
// system-wide unit. Refuse outright; never silently downgrade.
export const assertNotRoot = (action: string): void => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === 0) {
    throw new Error(
      `Refusing to ${action} as root.\n` +
        `hisohiso is a per-user service that wraps phone-driven agent processes; ` +
        `running it as root is unsafe. Re-run as your normal user (no sudo).`
    );
  }
};

// install requires an existing paired control room: a background service can't
// show a QR and block on a knock, so the operator pairs once interactively with
// `hisohiso daemon start`, then installs. On boot the daemon reuses the
// persisted control-room state and comes back without re-pairing.
export const isPaired = async (): Promise<boolean> => {
  const state = await loadDaemonState().catch(() => null);
  return Boolean(state && state.controlRoomHash);
};

const uid = (): number => userInfo().uid;

// --- launchd (macOS) ---

const launchdPlist = (execPath: string): string => {
  // PATH is captured from the installing shell so the backgrounded daemon can
  // still find the wrapped agent CLIs (claude/codex/…), which usually live in
  // ~/.local/bin or a Homebrew prefix that launchd's minimal PATH omits.
  const path = process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  const env: Record<string, string> = {
    [SERVICE_ENV_FLAG]: 'launchd',
    PATH: path,
  };
  // Carry an isolated state dir + auto-update opt-out through to the service so
  // an install from a custom HISOHISO_HOME doesn't silently target ~/.hisohiso.
  if (process.env.HISOHISO_HOME) env.HISOHISO_HOME = process.env.HISOHISO_HOME;
  if (process.env.HISOHISO_AUTO_UPDATE) env.HISOHISO_AUTO_UPDATE = process.env.HISOHISO_AUTO_UPDATE;

  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(execPath)}</string>
    <string>daemon</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>WorkingDirectory</key>
  <string>${escapeXml(homedir())}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(LOG_PATH)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(LOG_PATH)}</string>
</dict>
</plist>
`;
};

const escapeXml = (s: string): string =>
  s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;'
  );

// launchctl across macOS versions: prefer the modern bootstrap/bootout domain
// API, fall back to legacy load/unload if the host rejects it.
const launchctlLoad = async (): Promise<void> => {
  const domain = `gui/${uid()}`;
  try {
    await execFileP('launchctl', ['bootstrap', domain, PLIST_PATH]);
    return;
  } catch {
    // older macOS / already-bootstrapped — fall back
  }
  await execFileP('launchctl', ['load', '-w', PLIST_PATH]);
};

const launchctlUnload = async (): Promise<void> => {
  const domain = `gui/${uid()}`;
  try {
    await execFileP('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`]);
    return;
  } catch {
    // not bootstrapped this way — fall back
  }
  await execFileP('launchctl', ['unload', '-w', PLIST_PATH]).catch(() => {});
};

const launchdLoaded = async (): Promise<boolean> => {
  try {
    await execFileP('launchctl', ['print', `gui/${uid()}/${SERVICE_LABEL}`]);
    return true;
  } catch {
    return false;
  }
};

const installLaunchd = async (): Promise<{ unitPath: string; execPath: string }> => {
  const execPath = resolveExecPath();
  await mkdir(LAUNCH_AGENTS_DIR, { recursive: true });
  // Idempotent: if a unit is already loaded, unload before rewriting so the new
  // ProgramArguments/env take effect on reload.
  if (await launchdLoaded()) await launchctlUnload();
  await writeFile(PLIST_PATH, launchdPlist(execPath), 'utf-8');
  await launchctlLoad();
  return { unitPath: PLIST_PATH, execPath };
};

const uninstallLaunchd = async (): Promise<{ removed: boolean }> => {
  await launchctlUnload();
  const existed = await pathExists(PLIST_PATH);
  if (existed) await unlink(PLIST_PATH).catch(() => {});
  return { removed: existed };
};

// --- public, platform-dispatched API ---

export const installService = async (): Promise<{ manager: 'launchd'; unitPath: string; execPath: string }> => {
  if (platform() === 'darwin') {
    const { unitPath, execPath } = await installLaunchd();
    return { manager: 'launchd', unitPath, execPath };
  }
  if (platform() === 'linux') {
    throw new Error(
      'Linux (systemd user unit) service install lands in the next #125 PR.\n' +
        'For now, run `hisohiso daemon start` under your own process manager (systemd/tmux).'
    );
  }
  throw new Error(`Unsupported platform for service install: ${platform()} (macOS supported; Linux next).`);
};

export const uninstallService = async (): Promise<{ manager: 'launchd'; removed: boolean }> => {
  if (platform() === 'darwin') {
    const { removed } = await uninstallLaunchd();
    return { manager: 'launchd', removed };
  }
  if (platform() === 'linux') {
    throw new Error('Linux (systemd) service support lands in the next #125 PR; nothing to uninstall here yet.');
  }
  throw new Error(`Unsupported platform for service uninstall: ${platform()}.`);
};

// Read-only introspection for `hisohiso info` (#137) — truthful whether or not
// the daemon is running, and degrades cleanly off macOS.
export const getServiceInfo = async (): Promise<ServiceInfo> => {
  const plat = platform();
  if (plat === 'darwin') {
    const installed = await pathExists(PLIST_PATH);
    return {
      platform: plat,
      supported: true,
      manager: 'launchd',
      label: SERVICE_LABEL,
      unitPath: PLIST_PATH,
      installed,
      loaded: installed ? await launchdLoaded() : false,
    };
  }
  return {
    platform: plat,
    supported: false,
    manager: plat === 'linux' ? 'systemd' : null,
    label: SERVICE_LABEL,
    unitPath: null,
    installed: false,
    loaded: false,
  };
};

export { PLIST_PATH, LOG_PATH, CONFIG_DIR };
