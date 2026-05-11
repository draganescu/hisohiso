import { saveConfig, ensureConfigDir, type Config } from '../lib/config.js';

export const pair = async (server: string): Promise<void> => {
  await ensureConfigDir();

  // Verify server is reachable
  console.log(`Connecting to ${server}...`);
  try {
    const res = await fetch(`${server}/api/stats`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log('Server is reachable.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Cannot reach server: ${msg}`);
    process.exit(1);
  }

  const config: Config = { server };
  await saveConfig(config);

  console.log(`Saved server to ~/.hisohiso/config.json`);
  console.log(`\nYou can now run:`);
  console.log(`  hisohiso wrap -- <command>    One-shot agent bridge`);
  console.log(`  hisohiso daemon start         Background daemon`);
};
