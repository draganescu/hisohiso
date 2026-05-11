import { loadRegistry, saveRegistry, type RegisteredAgent } from '../lib/config.js';
import { createInterface } from 'node:readline';

const confirm = async (message: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
};

export const register = async (name: string, command: string, mode = 'default'): Promise<void> => {
  const agents = await loadRegistry();

  if (agents.find((a) => a.name === name)) {
    console.error(`Agent "${name}" is already registered. Unregister it first.`);
    process.exit(1);
  }

  console.log(`\nYou are about to register an agent that your phone will be able to run on this machine.\n`);
  console.log(`  Name:    ${name}`);
  console.log(`  Command: ${command}`);
  console.log(`  Mode:    ${mode}\n`);

  const ok = await confirm('Your phone will be able to run this command on this machine. Continue?');
  if (!ok) {
    console.log('Cancelled.');
    return;
  }

  agents.push({ name, command, mode });
  await saveRegistry(agents);
  console.log(`Registered "${name}".`);
};

export const unregister = async (name: string): Promise<void> => {
  const agents = await loadRegistry();
  const filtered = agents.filter((a) => a.name !== name);
  if (filtered.length === agents.length) {
    console.error(`Agent "${name}" is not registered.`);
    process.exit(1);
  }
  await saveRegistry(filtered);
  console.log(`Unregistered "${name}".`);
};

export const list = async (): Promise<void> => {
  const agents = await loadRegistry();
  if (agents.length === 0) {
    console.log('No agents registered. Use: hisohiso daemon register <name> --command <cmd>');
    return;
  }
  console.log('Registered agents:\n');
  for (const agent of agents) {
    console.log(`  ${agent.name}`);
    console.log(`    command: ${agent.command}`);
    console.log(`    mode:    ${agent.mode}`);
    console.log();
  }
};
