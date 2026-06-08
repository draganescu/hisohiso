#!/usr/bin/env node

import { Command } from 'commander';
import { wrap } from './commands/wrap.js';
import { daemonStart, daemonStop, daemonStatus, daemonInstall, daemonUninstall } from './commands/daemon.js';
import { register, unregister, list } from './commands/registry.js';
import { statusCmd, pairCmd, admitCmd, denyCmd, repairCmd, serverCmd } from './commands/control.js';
import { info } from './commands/info.js';
import { updateCmd } from './commands/update.js';
import { uninstallCmd } from './commands/uninstall.js';
import { skillsInstall, skillsStatusCmd, skillsUninstall } from './commands/skills.js';
import { listAgents } from './lib/agents.js';
// Single source of truth for the CLI version. release.sh bumps
// cli/package.json and the bundled binary picks it up at build time.
import pkg from '../package.json' with { type: 'json' };

const program = new Command();

program
  .name('hisohiso')
  .description('Control terminal agents from your phone over E2E encrypted channels')
  .version(pkg.version);

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
  .description('Move a running daemon to a new server (disband + re-pair), or set it for the next start')
  .argument('<url>', 'Server URL')
  .option('-y, --yes', 'Skip the destructive-migration confirmation')
  .action(async (url: string, opts: { yes?: boolean }) => {
    await serverCmd(url, { yes: opts.yes === true });
  });

program
  .command('agents')
  .description('List built-in agent profiles')
  .action(() => {
    console.log('Built-in agents:\n');
    for (const [name, agent] of Object.entries(listAgents())) {
      const mode = agent.mode === 'session' ? ' [session]' : '';
      console.log(`  ${name.padEnd(14)} ${agent.description}${mode}`);
      console.log(`  ${' '.repeat(14)} → ${agent.command} ${agent.args.join(' ')} <message>\n`);
    }
  });

// Control-plane verbs (#134) — talk to the running daemon over its control
// socket. Top-level (not under `daemon`) because they're the everyday surface
// for a detached daemon you drive from your phone.
program
  .command('info')
  .description('Show the whole daemon at a glance: paths, config, status, service, logs — works when down')
  .option('--json', 'Emit the full picture as JSON for scripting')
  .action(async (opts: { json?: boolean }) => {
    await info({ json: opts.json === true });
  });

program
  .command('status')
  .description('Show the running daemon: control room, agents, devices awaiting admission')
  .action(statusCmd);

program
  .command('pair')
  .description('Re-render the QR + pairing code for the current control room (e.g. to add a phone)')
  .action(pairCmd);

program
  .command('admit')
  .description('Admit a device waiting to join the control room')
  .argument('[id]', 'pending knock id (optional when only one is waiting)')
  .action(admitCmd);

program
  .command('deny')
  .description('Deny a device waiting to join the control room')
  .argument('[id]', 'pending knock id (optional when only one is waiting)')
  .action(denyCmd);

program
  .command('repair')
  .description('Clean slate: disband all rooms and re-pair the running daemon from scratch')
  .option('-y, --yes', 'Skip the destructive confirmation')
  .action(async (opts: { yes?: boolean }) => {
    await repairCmd({ yes: opts.yes === true });
  });

// Binary lifecycle (#153, #41) — manage the installed CLI itself, independent
// of any running daemon.
program
  .command('update')
  .description('Update the CLI to the latest release (verifies checksum), or --check for versions only')
  .option('--check', 'Report current vs latest version without downloading anything')
  .action(async (opts: { check?: boolean }) => {
    await updateCmd({ check: opts.check === true });
  });

program
  .command('uninstall')
  .description('Remove the CLI (stops daemon + service, deletes the binary); --clean also wipes local state')
  .option('--clean', 'Also remove ~/.hisohiso state and hisohiso-owned generated files')
  .option('--dry-run', 'Show what would be removed without changing anything')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action(async (opts: { clean?: boolean; dryRun?: boolean; yes?: boolean }) => {
    await uninstallCmd({ clean: opts.clean === true, dryRun: opts.dryRun === true, yes: opts.yes === true });
  });

// Agent skills (SKILL.md docs) — install the CLI's bundled skills into the
// standard skill dirs (~/.claude, ~/.codex, ~/.agents) the wrapped agent reads
// natively. Opt-in; does not touch the agent spawn path.
const skills = program
  .command('skills')
  .description('Manage the bundled agent skills the wrapped agent can load');

skills
  .command('install')
  .description('Install/update the bundled skills into ~/.claude, ~/.codex and ~/.agents')
  .action(skillsInstall);

skills
  .command('status')
  .description('Show whether the bundled skills are installed and up to date')
  .action(skillsStatusCmd);

skills
  .command('uninstall')
  .description('Remove the bundled skills from the skill directories')
  .action(skillsUninstall);

const daemon = program
  .command('daemon')
  .description('Manage the background daemon');

daemon
  .command('start')
  .description('Start the daemon')
  .option('--fresh', 'Disband saved control + agent rooms and start with a new QR')
  .action(async (opts: { fresh?: boolean }) => {
    await daemonStart({ fresh: opts.fresh === true });
  });

daemon
  .command('stop')
  .description('Stop the daemon')
  .action(daemonStop);

daemon
  .command('install')
  .description('Install a per-user background service (launchd/systemd) that survives reboots — pair first')
  .action(daemonInstall);

daemon
  .command('uninstall')
  .description('Stop and remove the background service (preserves local daemon state)')
  .action(daemonUninstall);

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
  .option('--needs-room-secret', 'Export HISOHISO_ROOM_SECRET into this agent (off by default)', false)
  .action(async (name: string, opts: { command: string; mode: string; needsRoomSecret?: boolean }) => {
    await register(name, opts.command, opts.mode, opts.needsRoomSecret ?? false);
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

await program.parseAsync();
