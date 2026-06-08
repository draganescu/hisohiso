import { BUNDLED_SKILLS } from '../lib/skills/bundled.js';
import {
  installSkills,
  skillsStatus,
  skillTargetDirs,
  uninstallSkills,
} from '../lib/skill-sync.js';

// `hisohiso skills` — install the CLI's bundled agent skills into the standard
// skill directories the wrapped agent (claude/codex) discovers natively. Opt-in
// and additive: it never touches the agent spawn path.

const skillNames = (): string => BUNDLED_SKILLS.map((s) => s.name).join(', ');

export const skillsInstall = async (): Promise<void> => {
  const { changedFiles, skillDirs } = await installSkills(BUNDLED_SKILLS);
  if (changedFiles === 0) {
    console.log(`Skills already up to date (${skillNames()}).`);
  } else {
    console.log(`Installed/updated ${changedFiles} file(s) for: ${skillNames()}`);
  }
  console.log('\nInstalled into:');
  for (const dir of new Set(skillDirs.map((d) => d.replace(/\/[^/]+$/, '')))) {
    console.log(`  ${dir}`);
  }
};

export const skillsStatusCmd = async (): Promise<void> => {
  const status = await skillsStatus(BUNDLED_SKILLS);
  console.log(`Bundled skills: ${skillNames()}`);
  console.log(`Overall: ${status.state}\n`);
  for (const t of status.targets) {
    console.log(`  [${t.state.padEnd(13)}] ${t.dir}`);
  }
  if (status.state !== 'up-to-date') {
    console.log('\nRun `hisohiso skills install` to sync.');
  }
};

export const skillsUninstall = async (): Promise<void> => {
  await uninstallSkills(BUNDLED_SKILLS);
  console.log(`Removed bundled skills (${skillNames()}) from:`);
  for (const dir of skillTargetDirs()) {
    console.log(`  ${dir}`);
  }
};

/**
 * Idempotently install the bundled skills wherever a wrapped agent is about to
 * run (daemon start/install, wrap). Silent on no-op, non-fatal on error — a
 * read-only HOME must never block the daemon or a wrap session. Because the
 * sync only writes on change, this also self-heals after a CLI auto-update.
 */
export const ensureBundledSkills = async (): Promise<void> => {
  try {
    const { changedFiles } = await installSkills(BUNDLED_SKILLS);
    if (changedFiles > 0) {
      console.log(`Installed agent skills (${skillNames()}) into ~/.claude, ~/.codex, ~/.agents.`);
    }
  } catch (err) {
    console.error(
      `Note: could not install bundled agent skills (${(err as Error).message}). Continuing.`,
    );
  }
};
