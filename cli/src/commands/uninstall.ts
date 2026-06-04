// `hisohiso uninstall` (#41) — first-class removal of the CLI, mirroring the
// curl installer. Two levels:
//
//   hisohiso uninstall          stop the daemon + remove the background service,
//                               delete the installed binary, KEEP ~/.hisohiso.
//   hisohiso uninstall --clean  also delete ~/.hisohiso (config, registry, rooms,
//                               pid, logs) and any hisohiso-owned generated files
//                               recorded in the manifest, and remove the managed
//                               PATH block the installer wrote to your shell rc.
//
// Flags: --dry-run (print the plan, change nothing) · --yes (skip confirmation).
//
// Safety (per #41): --clean is destructive and confirms by default; we never
// remove arbitrary name-matched files — only the running binary, our own state
// dir, and paths a hisohiso-written manifest claims ownership of; and we never
// edit shell rc files except a managed marker block the installer itself wrote.

import { rm, readFile, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveExecPath } from '../lib/updater.js';
import { uninstallService, getServiceInfo } from '../lib/service.js';
import { isDaemonRunning } from '../daemon/pid.js';
import { daemonStop } from './daemon.js';
import { promptLine } from '../lib/prompt.js';
import { CONFIG_DIR } from '../lib/config.js';

// Must match the block install.sh writes (and removeRcBlock below).
const MARKER_BEGIN = '# >>> hisohiso installer >>>';
const MARKER_END = '# <<< hisohiso installer <<<';

type Outcome = { removed: string[]; skipped: string[]; missing: string[] };

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

// hisohiso-owned generated files (e.g. agent wrappers) recorded by whatever
// created them, so `--clean` removes exactly what we own and nothing it guessed
// by name. Absent today (no generator writes it yet) → wrapper removal is a safe
// no-op; once wrapper generation lands it appends here.
const readManifest = async (): Promise<string[]> => {
  try {
    const arr = JSON.parse(await readFile(join(CONFIG_DIR, 'created-files.json'), 'utf-8'));
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

// The shell rc the installer would have appended to (mirrors install.sh's
// detect_shell_config).
const shellRcPath = (): string | null => {
  const shell = basename(process.env.SHELL || '');
  if (shell === 'zsh') return join(homedir(), '.zshrc');
  if (shell === 'bash') return process.platform === 'darwin' ? join(homedir(), '.bash_profile') : join(homedir(), '.bashrc');
  if (shell === 'fish') return join(homedir(), '.config', 'fish', 'config.fish');
  return null;
};

// Remove only the managed marker block (inclusive). Leaves the rest untouched.
const removeRcBlock = async (rcPath: string): Promise<void> => {
  const lines = (await readFile(rcPath, 'utf-8')).split('\n');
  const start = lines.findIndex((l) => l.trim() === MARKER_BEGIN);
  const end = lines.findIndex((l) => l.trim() === MARKER_END);
  if (start === -1 || end === -1 || end < start) return;
  lines.splice(start, end - start + 1);
  // Drop a single blank line left dangling where the block was, if any.
  if (lines[start] === '' && (start === 0 || lines[start - 1] === '')) lines.splice(start, 1);
  await writeFile(rcPath, lines.join('\n'), 'utf-8');
};

const removeOne = async (path: string, out: Outcome, recursive = false): Promise<void> => {
  if (!(await exists(path))) {
    out.missing.push(path);
    return;
  }
  try {
    await rm(path, { force: true, recursive });
    out.removed.push(path);
  } catch (err) {
    out.skipped.push(`${path}: ${(err as Error).message}`);
  }
};

export const uninstallCmd = async (
  opts: { clean?: boolean; dryRun?: boolean; yes?: boolean } = {}
): Promise<void> => {
  const clean = opts.clean === true;
  const dry = opts.dryRun === true;
  const execPath = resolveExecPath();

  // Build the plan first so --dry-run and the confirmation prompt show exactly
  // the same set of paths we'll act on.
  const manifestFiles = clean ? await readManifest() : [];
  const service = await getServiceInfo();
  const rc = shellRcPath();
  const rcHasBlock = rc && (await exists(rc)) ? (await readFile(rc, 'utf-8')).includes(MARKER_BEGIN) : false;

  console.log(clean ? 'hisohiso uninstall --clean will:' : 'hisohiso uninstall will:');
  if (service.installed) {
    console.log(`  • stop + remove the ${service.manager} service  (${service.unitPath})`);
  }
  console.log('  • stop the daemon if it is running');
  console.log(`  • remove the binary            ${execPath}`);
  if (clean) {
    console.log(`  • remove all local state       ${CONFIG_DIR}`);
    for (const f of manifestFiles) console.log(`  • remove generated file        ${f}`);
    if (rcHasBlock) console.log(`  • remove the PATH block from   ${rc}`);
  } else {
    console.log(`  • preserve local state         ${CONFIG_DIR}`);
  }

  if (dry) {
    console.log('\n(dry run — nothing was changed.)');
    return;
  }

  if (!opts.yes) {
    const ans = (await promptLine('\nProceed? This cannot be undone. [y/N] ')).trim().toLowerCase();
    if (ans !== 'y' && ans !== 'yes') {
      console.log('Aborted.');
      return;
    }
  }
  console.log('');

  const out: Outcome = { removed: [], skipped: [], missing: [] };

  // 1. Background service + daemon. uninstallService stops + removes a launchd/
  // systemd service (which also stops its daemon); daemonStop catches a
  // manually-started foreground daemon. Gate on installed so we never poke the
  // service manager (which targets the fixed per-user label) when there's no
  // unit to remove.
  if (service.installed) {
    try {
      const { manager, removed } = await uninstallService();
      if (removed) out.removed.push(`${manager} service (${service.unitPath})`);
    } catch (err) {
      out.skipped.push(`service: ${(err as Error).message}`);
    }
  }
  if (await isDaemonRunning()) {
    await daemonStop(); // prints its own status line
  }

  // 2. The binary itself. Unlinking the running executable is safe on macOS/
  // Linux — the inode survives until this process exits.
  await removeOne(execPath, out);

  // 3. --clean: manifest-owned files, then the whole state dir, then the rc block.
  if (clean) {
    for (const f of manifestFiles) await removeOne(f, out);
    await removeOne(CONFIG_DIR, out, true);
    if (rc && rcHasBlock) {
      try {
        await removeRcBlock(rc);
        out.removed.push(`PATH block in ${rc}`);
      } catch (err) {
        out.skipped.push(`${rc}: ${(err as Error).message}`);
      }
    }
  }

  // Summary
  if (out.removed.length) {
    console.log('Removed:');
    for (const p of out.removed) console.log(`  ${p}`);
  }
  if (out.missing.length) {
    console.log('Already gone:');
    for (const p of out.missing) console.log(`  ${p}`);
  }
  if (out.skipped.length) {
    console.log('Skipped (errors — left in place):');
    for (const p of out.skipped) console.log(`  ${p}`);
  }

  if (clean) {
    console.log('\nhisohiso fully uninstalled.');
    if (rc && !rcHasBlock) {
      console.log(`Note: ${rc} may still hold a PATH line from an older installer (no managed marker block to remove). Remove it by hand if you like.`);
    }
  } else {
    console.log(`\nhisohiso uninstalled. Local state preserved at ${CONFIG_DIR}.`);
    console.log('To remove all hisohiso state too, run:\n  hisohiso uninstall --clean');
  }
};
