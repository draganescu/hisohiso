import { afterEach, beforeEach, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  installSkills,
  skillsStatus,
  skillTargetDirs,
  uninstallSkills,
  type BundledSkill,
} from './skill-sync.js';

let home: string;

const SKILL: BundledSkill = {
  name: 'hisohiso-blocks',
  files: { 'SKILL.md': '---\nname: hisohiso-blocks\n---\nhello\n' },
};

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'hh-skill-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const targets = () => skillTargetDirs(home);
const skillFile = (dir: string) => path.join(dir, 'hisohiso-blocks', 'SKILL.md');

test('install writes the skill into all three target dirs', async () => {
  const { changedFiles } = await installSkills([SKILL], targets());
  expect(changedFiles).toBe(3); // one SKILL.md per target
  for (const dir of targets()) {
    expect(await fs.readFile(skillFile(dir), 'utf-8')).toContain('name: hisohiso-blocks');
  }
});

test('install is idempotent — re-running changes nothing', async () => {
  await installSkills([SKILL], targets());
  const { changedFiles } = await installSkills([SKILL], targets());
  expect(changedFiles).toBe(0);
});

test('status reports not-installed, then up-to-date, then drift', async () => {
  expect((await skillsStatus([SKILL], targets())).state).toBe('not-installed');

  await installSkills([SKILL], targets());
  expect((await skillsStatus([SKILL], targets())).state).toBe('up-to-date');

  await fs.writeFile(skillFile(targets()[0]), 'tampered');
  expect((await skillsStatus([SKILL], targets())).state).toBe('drift');
});

test('reinstall over an operator edit restores the bundled content', async () => {
  await installSkills([SKILL], targets());
  await fs.writeFile(skillFile(targets()[0]), 'tampered');
  const { changedFiles } = await installSkills([SKILL], targets());
  expect(changedFiles).toBe(1); // only the tampered file is rewritten
  expect(await fs.readFile(skillFile(targets()[0]), 'utf-8')).toContain('hello');
});

test('a bundled file dropped from the skill is pruned on next install (manifest-tracked)', async () => {
  const twoFiles: BundledSkill = {
    name: 'hisohiso-blocks',
    files: { 'SKILL.md': SKILL.files['SKILL.md'], 'extra.md': 'temp\n' },
  };
  await installSkills([twoFiles], targets());
  expect(await fs.readFile(path.join(targets()[0], 'hisohiso-blocks', 'extra.md'), 'utf-8')).toBe(
    'temp\n',
  );

  await installSkills([SKILL], targets()); // extra.md no longer bundled
  await expect(
    fs.readFile(path.join(targets()[0], 'hisohiso-blocks', 'extra.md'), 'utf-8'),
  ).rejects.toThrow();
});

test('uninstall removes the skill dirs', async () => {
  await installSkills([SKILL], targets());
  await uninstallSkills([SKILL], targets());
  for (const dir of targets()) {
    await expect(fs.readFile(skillFile(dir), 'utf-8')).rejects.toThrow();
  }
});
