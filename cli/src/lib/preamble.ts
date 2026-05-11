import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREAMBLES_DIR = join(__dirname, '..', '..', 'preambles');

export const getPreamble = async (agentName?: string): Promise<string> => {
  if (agentName) {
    try {
      return await readFile(join(PREAMBLES_DIR, `${agentName}.md`), 'utf-8');
    } catch {
      // Fall through to default
    }
  }
  return readFile(join(PREAMBLES_DIR, 'default.md'), 'utf-8');
};
