#!/usr/bin/env node

import { Command } from 'commander';
import { wrap } from './commands/wrap.js';
import { daemonStart, daemonStop, daemonStatus } from './commands/daemon.js';
import { register, unregister, list } from './commands/registry.js';
import { saveConfig, ensureConfigDir } from './lib/config.js';
import { listAgents } from './lib/agents.js';

const program = new Command();

program
  .name('hisohiso')
  .description('Control terminal agents from your phone over E2E encrypted channels')
  .version('0.1.0');

program
  .command('wrap')
  .description('Bridge an agent to your phone. Built-in agents: ' + Object.keys(listAgents()).join(', '))
  .argument('<agent>', 'Agent name (claude, aider, codex, bash, ...) or custom command after --')
  .action(async (agent: string, _opts: unknown, cmd: Command) => {
    // Check if there are extra args after -- (custom command)
    const extraArgs = cmd.args.slice(1);
    if (extraArgs.length > 0) {
      await wrap(agent, [agent, ...extraArgs]);
    } else {
      await wrap(agent);
    }
  });

program
  .command('server')
  .description('Set a custom server (default: hisohiso.org)')
  .argument('<url>', 'Server URL')
  .action(async (url: string) => {
    await ensureConfigDir();
    await saveConfig({ server: url });
    console.log(`Server set to ${url}`);
  });

program
  .command('agents')
  .description('List built-in agent profiles')
  .action(() => {
    console.log('Built-in agents:\n');
    for (const [name, agent] of Object.entries(listAgents())) {
      console.log(`  ${name.padEnd(10)} ${agent.description}`);
      console.log(`  ${' '.repeat(10)} → ${agent.command} ${agent.args.join(' ')} <message>\n`);
    }
  });

const daemon = program
  .command('daemon')
  .description('Manage the background daemon');

daemon
  .command('start')
  .description('Start the daemon')
  .action(daemonStart);

daemon
  .command('stop')
  .description('Stop the daemon')
  .action(daemonStop);

daemon
  .command('status')
  .description('Check daemon status')
  .action(daemonStatus);

daemon
  .command('register')
  .description('Register an agent command')
  .argument('<name>', 'Agent name')
  .requiredOption('--command <cmd>', 'Shell command to spawn')
  .option('--mode <profile>', 'Preamble profile', 'default')
  .action(async (name: string, opts: { command: string; mode: string }) => {
    await register(name, opts.command, opts.mode);
  });

daemon
  .command('unregister')
  .description('Unregister an agent command')
  .argument('<name>', 'Agent name')
  .action(unregister);

daemon
  .command('list')
  .description('List registered agents')
  .action(list);

program.parse();
