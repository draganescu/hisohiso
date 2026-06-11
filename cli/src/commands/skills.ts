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
  const { changedFiles } = await installSkills(BUNDLED_SKILLS);
  if (changedFiles === 0) {
    console.log(`Skills already up to date (${skillNames()}).`);
  } else {
    console.log(`Installed/updated ${changedFiles} file(s) for: ${skillNames()}`);
  }
  console.log('\nInstalled into:');
  for (const dir of skillTargetDirs()) {
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
