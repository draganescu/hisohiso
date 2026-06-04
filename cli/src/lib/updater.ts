// Sparkle-style updater for the hisohiso CLI.
//
// The model: GitHub Releases plays the role of Sparkle's appcast. Any process
// hits the releases/latest API, compares the tag to the version baked into this
// binary, and — if newer — downloads the matching arch binary, verifies its
// SHA-256 against the checksums.txt asset on the same release, and atomically
// swaps it over the on-disk binary.
//
// Two entry points share that download/verify/swap core (see #153 — no second
// implementation to keep in sync):
//   • startUpdateLoop()  — the daemon's background tick: also waits for idle and
//     re-execs the running process onto the new binary.
//   • applyUpdate()      — the on-demand `hisohiso update` command: swaps the
//     binary and returns; the caller (not a long-running daemon) just exits.
//   • checkLatest()      — version probe shared by both and by `update --check`.
//
// Guard rails:
//   • HISOHISO_AUTO_UPDATE=off short-circuits the daemon tick (an explicit
//     `hisohiso update` is a deliberate request and runs regardless).
//   • The first daemon tick is delayed FIRST_TICK_DELAY_MS after boot so a
//     freshly-installed binary doesn't immediately re-update — a window to
//     catch a bad release.
//   • The loop passes an isIdle() probe; we wait until it returns true before
//     swapping, so re-execing mid-turn doesn't orphan agent subprocesses.
//   • Same-filesystem atomic rename: tmp file lives next to execPath as
//     `${execPath}.new`, so fs.rename is a single inode swap.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };

// Bun-compiled binaries report a virtual /$bunfs/… path for process.execPath.
// Resolve the real filesystem path from argv[0] instead. Exported so the
// service-install unit (#125), `hisohiso info` (#137), and `uninstall` (#41)
// point at the real on-disk binary rather than the /$bunfs virtual path.
export function resolveExecPath(): string {
  const argv0 = process.argv[0];
  if (argv0 && !argv0.startsWith('/$bunfs')) {
    try {
      return realpathSync(resolve(argv0));
    } catch {
      // fall through
    }
  }
  return process.execPath;
}

const EXEC_PATH = resolveExecPath();

const REPO = 'draganescu/hisohiso';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const FIRST_TICK_DELAY_MS = 30 * 60 * 1000;      // 30 min
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6 h
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;           // 30 min cap on idle wait
const IDLE_POLL_MS = 2_000;

const USER_AGENT = `hisohiso-cli/${pkg.version}`;

type ReleaseAsset = { name: string; browser_download_url: string };
type ReleaseInfo = { tag: string; assets: ReleaseAsset[] };

// --- shared core: version check + download/verify/stage ---

export type CheckResult = {
  current: string;
  latest: string | null; // null => couldn't reach / parse the release
  isNewer: boolean;
  release: ReleaseInfo | null;
};

// Probe the latest release and compare to this binary's version. Used by the
// daemon tick, `applyUpdate`, and `update --check` — one network+compare path.
export async function checkLatest(apiUrl: string = API_URL): Promise<CheckResult> {
  const current = pkg.version;
  const release = await fetchLatestRelease(apiUrl);
  if (release === null) return { current, latest: null, isNewer: false, release: null };
  return { current, latest: release.tag, isNewer: isNewerVersion(release.tag, current), release };
}

type ResolvedAssets = { assetName: string; binaryUrl: string; checksumsUrl: string };

// Pick the binary + checksums asset for this platform off a release, or explain
// why we can't (unsupported arch, or a release missing assets).
function resolveAssets(release: ReleaseInfo): ResolvedAssets | { error: string } {
  const platformId = detectPlatform();
  if (platformId === null) return { error: `unsupported platform ${process.platform}/${process.arch}` };
  const assetName = `hisohiso-${platformId}`;
  const binaryAsset = release.assets.find((a) => a.name === assetName);
  const checksumsAsset = release.assets.find((a) => a.name === 'checksums.txt');
  if (!binaryAsset || !checksumsAsset) {
    return { error: `release ${release.tag} is missing ${assetName} or checksums.txt` };
  }
  return { assetName, binaryUrl: binaryAsset.browser_download_url, checksumsUrl: checksumsAsset.browser_download_url };
}

// Download + checksum-verify + chmod into `${execPath}.new`, ready for an atomic
// rename over execPath. Throws (after cleaning up the tmp file) on any failure.
// The single download/verify implementation both callers use.
async function stageBinary(assets: ResolvedAssets, execPath: string, log: (m: string) => void): Promise<string> {
  const tmpPath = `${execPath}.new`;
  await fs.rm(tmpPath, { force: true }); // clear a stale tmp from a prior failed attempt
  log(`downloading ${assets.assetName}...`);
  await downloadTo(assets.binaryUrl, tmpPath);
  log(`verifying checksum...`);
  const ok = await verifyChecksum(tmpPath, assets.checksumsUrl, assets.assetName);
  if (!ok) {
    await fs.rm(tmpPath, { force: true });
    throw new Error(`checksum mismatch on ${assets.assetName}`);
  }
  await fs.chmod(tmpPath, 0o755);
  return tmpPath;
}

// --- on-demand `hisohiso update` (no idle wait, no re-exec) ---

export type ApplyResult =
  | { status: 'updated'; from: string; to: string }
  | { status: 'already-latest'; current: string }
  | { status: 'no-release'; current: string }
  | { status: 'unsupported'; current: string; reason: string }
  | { status: 'failed'; current: string; reason: string };

// Update the on-disk binary now and return the outcome. Unlike the daemon loop
// this does NOT wait for idle or re-exec — the `update` command is a short-lived
// process; it swaps the binary and exits, and any running daemon picks up the
// new binary on its next start/tick.
export async function applyUpdate(opts: { apiUrl?: string; log?: (m: string) => void } = {}): Promise<ApplyResult> {
  const log = opts.log ?? (() => {});
  const { current, isNewer, release } = await checkLatest(opts.apiUrl);
  if (release === null) return { status: 'no-release', current };
  if (!isNewer) return { status: 'already-latest', current };
  const assets = resolveAssets(release);
  if ('error' in assets) return { status: 'unsupported', current, reason: assets.error };
  let tmpPath: string;
  try {
    tmpPath = await stageBinary(assets, EXEC_PATH, log);
  } catch (err) {
    return { status: 'failed', current, reason: err instanceof Error ? err.message : String(err) };
  }
  await fs.rename(tmpPath, EXEC_PATH);
  return { status: 'updated', from: current, to: release.tag };
}

// --- daemon background auto-update loop ---

export type StartUpdateLoopOpts = {
  // Returns true when it's safe to swap+re-exec. The daemon should return
  // true when no agent session has its `running` flag set.
  isIdle: () => boolean;
  intervalMs?: number;
  // For testing — override the release URL.
  apiUrl?: string;
  // Where to log. Daemon passes its own logger; wrap uses console.
  log?: (msg: string) => void;
};

export function startUpdateLoop(opts: StartUpdateLoopOpts): void {
  const log = opts.log ?? ((m) => console.error(`[updater] ${m}`));
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const apiUrl = opts.apiUrl ?? API_URL;

  const fire = () => {
    void tick({ ...opts, log, apiUrl }).catch((err) => {
      log(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  // setTimeout for the first tick so a busy-loop test doesn't immediately
  // hammer GH on startup. setInterval after that.
  setTimeout(fire, FIRST_TICK_DELAY_MS);
  setInterval(fire, interval);
}

type TickCtx = StartUpdateLoopOpts & { log: (m: string) => void; apiUrl: string };

async function tick(ctx: TickCtx): Promise<void> {
  if (process.env.HISOHISO_AUTO_UPDATE === 'off') {
    return; // opted out, silent
  }

  const { isNewer, release } = await checkLatest(ctx.apiUrl);
  if (release === null) {
    ctx.log(`no release info`);
    return;
  }
  if (!isNewer) {
    return; // already up to date
  }

  ctx.log(`update available: ${pkg.version} → ${release.tag}`);

  const assets = resolveAssets(release);
  if ('error' in assets) {
    ctx.log(`${assets.error}; skipping update`);
    return;
  }

  let tmpPath: string;
  try {
    tmpPath = await stageBinary(assets, EXEC_PATH, ctx.log);
  } catch (err) {
    ctx.log(`${err instanceof Error ? err.message : String(err)}; discarding download`);
    return;
  }

  // Don't yank the binary mid-turn. Children spawned with the OLD binary keep
  // their inode (POSIX rename only changes the pathname), so the swap is safe
  // per se — but we still wait so the new daemon starts in a clean state with
  // no in-flight work to reattach to.
  ctx.log(`waiting for agent sessions to go idle...`);
  const becameIdle = await waitForIdle(ctx.isIdle, IDLE_TIMEOUT_MS);
  if (!becameIdle) {
    ctx.log(`timed out waiting for idle; will retry next tick`);
    await fs.rm(tmpPath, { force: true });
    return;
  }

  ctx.log(`swapping binary and re-execing...`);
  await fs.rename(tmpPath, EXEC_PATH);

  // Re-exec with the USER args only — slice(2), not slice(1). In a Bun-
  // compiled binary process.argv is [binary, /$bunfs/<entry>, ...userArgs],
  // mirroring Node's [node, script.js, ...]. If we forward argv[1] (the
  // /$bunfs entry), the new Bun runtime re-inserts its own entry at argv[1]
  // and our forwarded one slides to argv[2] — where Commander reads the
  // subcommand. Result: `unknown command '/$bunfs/root/…'`.
  // `detached: true` + `unref` lets the new process outlive us; `stdio:
  // 'inherit'` keeps logs going to the daemon log / user terminal.
  const child = spawn(EXEC_PATH, process.argv.slice(2), {
    detached: true,
    stdio: 'inherit',
    // HISOHISO_REEXEC tells the child's single-instance guard this is a handoff,
    // not a duplicate — so it waits for us to release the control socket (we
    // don't close it before spawning) rather than refusing to start.
    env: { ...process.env, HISOHISO_REEXEC: '1' },
  });
  child.unref();
  // Give the new process a beat to grab whatever resources we held.
  setTimeout(() => process.exit(0), 250);
}

// --- helpers ---

async function fetchLatestRelease(apiUrl: string): Promise<ReleaseInfo | null> {
  const res = await fetch(apiUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { tag_name?: string; assets?: ReleaseAsset[] };
  if (typeof body.tag_name !== 'string' || !Array.isArray(body.assets)) return null;
  return { tag: body.tag_name, assets: body.assets };
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`download ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
}

async function verifyChecksum(filePath: string, checksumsUrl: string, assetName: string): Promise<boolean> {
  const res = await fetch(checksumsUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return false;
  const manifest = await res.text();
  // Format from `shasum -a 256`: "<64 hex>  <filename>"
  const entry = manifest
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.endsWith(`  ${assetName}`) || line.endsWith(` ${assetName}`));
  if (!entry) return false;
  const expected = entry.split(/\s+/)[0]?.toLowerCase();
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) return false;

  const actual = createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
  return actual.toLowerCase() === expected;
}

function detectPlatform(): string | null {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  if (os === null) return null;
  // Bun/Node report arm64 as 'arm64', x64 as 'x64'. Match the release naming.
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (arch === null) return null;
  return `${os}-${arch}`;
}

// Lexicographic comparison won't do — we want 0.4.10 > 0.4.9. Hand-rolled
// rather than pulling semver: tags here always match /^v?\d+\.\d+\.\d+$/.
function isNewerVersion(remoteTag: string, current: string): boolean {
  const parse = (s: string): number[] | null => {
    const m = s.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const a = parse(remoteTag);
  const b = parse(current);
  if (a === null || b === null) return false; // unknown shape, never trigger
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}

async function waitForIdle(isIdle: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isIdle()) return true;
    await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
  }
  return isIdle();
}
