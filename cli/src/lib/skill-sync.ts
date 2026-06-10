import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// hisohiso ships agent skills (SKILL.md docs) the same way Paseo does: the
// bundled content is written into the standard skill directories that the
// wrapped agent already discovers natively. We support all three so the same
// install works whether the operator wraps `claude`, `codex`, or a generic
// `.agents`-aware tool.
//
// Unlike Paseo (an Electron app that copies from a resources/ dir), the
// hisohiso CLI ships as a single compiled binary, so the canonical skill
// content is inlined in TypeScript (see lib/skills/bundled.ts) — matching the
// existing inline-preamble pattern in lib/preamble.ts — and written to disk at
// install time.

export interface BundledSkill {
  /** Directory name under <agent>/skills, also the skill's frontmatter name. */
  name: string;
  /** Map of POSIX-relative path -> file content, e.g. { "SKILL.md": "..." }. */
  files: Record<string, string>;
}

export type SkillState = 'not-installed' | 'up-to-date' | 'drift';

export interface SkillStatus {
  state: SkillState;
  /** Per-target detail, one entry per skill dir we manage. */
  targets: Array<{ dir: string; state: SkillState }>;
}

/** The skill directories the wrapped agent discovers natively. */
export function skillTargetDirs(home: string = homedir()): string[] {
  return [
    path.join(home, '.claude', 'skills'),
    path.join(home, '.codex', 'skills'),
    path.join(home, '.agents', 'skills'),
  ];
}

const MANAGED_MANIFEST = '.hisohiso-managed-files.json';

interface ManagedManifest {
  version: 1;
  files: Record<string, string>;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function sameHashes(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

async function readManifest(skillDir: string): Promise<ManagedManifest | null> {
  const raw = await fs
    .readFile(path.join(skillDir, MANAGED_MANIFEST), 'utf-8')
    .catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ManagedManifest>;
    if (parsed.version !== 1 || typeof parsed.files !== 'object' || parsed.files === null) {
      return null;
    }
    return { version: 1, files: parsed.files as Record<string, string> };
  } catch {
    return null;
  }
}

/**
 * Write one skill into one target dir (e.g. ~/.claude/skills/hisohiso-blocks).
 * Idempotent: only touches files whose content changed. Files we previously
 * wrote but that are no longer bundled are removed — but ONLY if the on-disk
 * copy still matches what we wrote (an operator edit is left untouched).
 * Returns the number of files added/updated/removed.
 */
async function syncSkillIntoDir(skill: BundledSkill, skillDir: string): Promise<number> {
  let changed = 0;
  const nextHashes: Record<string, string> = {};

  for (const [rel, content] of Object.entries(skill.files)) {
    nextHashes[rel] = sha256(content);
    const dst = path.join(skillDir, rel);
    const current = await fs.readFile(dst, 'utf-8').catch(() => null);
    if (current === content) continue;
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(dst, content);
    changed++;
  }

  const previous = await readManifest(skillDir);
  for (const [rel, prevHash] of Object.entries(previous?.files ?? {})) {
    if (rel in skill.files) continue;
    const dst = path.join(skillDir, rel);
    const current = await fs.readFile(dst, 'utf-8').catch(() => null);
    if (current === null || sha256(current) !== prevHash) continue; // operator-modified -> keep
    await fs.rm(dst, { force: true });
    changed++;
  }

  // Rewrite the manifest only when the tracked set changed — reuse `previous`
  // (already read above) instead of reading the file back.
  if (!previous || !sameHashes(previous.files, nextHashes)) {
    await fs.mkdir(skillDir, { recursive: true });
    const manifest: ManagedManifest = { version: 1, files: nextHashes };
    await fs.writeFile(
      path.join(skillDir, MANAGED_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
  return changed;
}

/** Install (or update) every bundled skill into every target dir. */
export async function installSkills(
  skills: readonly BundledSkill[],
  targetDirs: readonly string[] = skillTargetDirs(),
): Promise<{ changedFiles: number }> {
  let changedFiles = 0;
  for (const dir of targetDirs) {
    for (const skill of skills) {
      changedFiles += await syncSkillIntoDir(skill, path.join(dir, skill.name));
    }
  }
  return { changedFiles };
}

/** Remove every bundled skill from every target dir (uninstall). */
export async function uninstallSkills(
  skills: readonly BundledSkill[],
  targetDirs: readonly string[] = skillTargetDirs(),
): Promise<void> {
  for (const dir of targetDirs) {
    for (const skill of skills) {
      await fs.rm(path.join(dir, skill.name), { recursive: true, force: true });
    }
  }
}

async function skillStateInDir(skill: BundledSkill, skillDir: string): Promise<SkillState> {
  let anyPresent = false;
  for (const [rel, content] of Object.entries(skill.files)) {
    const current = await fs.readFile(path.join(skillDir, rel), 'utf-8').catch(() => null);
    if (current !== null) anyPresent = true;
    if (current !== content) {
      return anyPresent ? 'drift' : 'not-installed';
    }
  }
  return 'up-to-date';
}

/** Report whether the bundled skills are installed and current. */
export async function skillsStatus(
  skills: readonly BundledSkill[],
  targetDirs: readonly string[] = skillTargetDirs(),
): Promise<SkillStatus> {
  const targets: SkillStatus['targets'] = [];
  let state: SkillState = 'up-to-date'; // worst seen; precedence not-installed > drift
  for (const dir of targetDirs) {
    let dirState: SkillState = 'up-to-date';
    for (const skill of skills) {
      const s = await skillStateInDir(skill, path.join(dir, skill.name));
      if (s === 'not-installed') {
        dirState = 'not-installed';
        break;
      }
      if (s === 'drift') dirState = 'drift';
    }
    targets.push({ dir, state: dirState });
    if (dirState === 'not-installed') state = 'not-installed';
    else if (dirState === 'drift' && state === 'up-to-date') state = 'drift';
  }
  return { state, targets };
}
