#!/usr/bin/env node

import { Command } from 'commander';
import { pair } from './commands/pair.js';
import { wrap } from './commands/wrap.js';
import { daemonStart, daemonStop, daemonStatus } from './commands/daemon.js';
import { register, unregister, list } from './commands/registry.js';
const program = new Command();

program
  .name('hisohiso')
  .description('Control terminal agents from your phone over E2E encrypted channels')
  .version('0.1.0');

program
  .command('pair')
  .description('Pair this machine with your phone')
  .requiredOption('--server <url>', 'Hisohiso server URL')
  .action(async (opts: { server: string }) => {
    await pair(opts.server);
  });

program
  .command('wrap')
  .description('One-shot: spawn a command and bridge its stdio to a Hisohiso room')
  .argument('<command...>', 'Command and arguments to run')
  .action(async (command: string[]) => {
    await wrap(command);
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
