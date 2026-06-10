// Install detection for spawnable agents. The daemon only offers agents whose
// underlying command actually resolves on this host's PATH — so the phone's
// launcher never lists a "Claude" button that errors out with ENOENT the moment
// it's tapped. hisohiso has always assumed the wrapped agent CLI is installed
// and authenticated by the operator (it does not install or log in for you);
// this just stops us advertising agents that aren't there.
//
// Scope note: we can verify a command is *installed* (on PATH, executable) but
// not that it's *authenticated*. Auth state is agent-specific and can only be
// learned by actually running the agent, which we won't do speculatively. So
// "available" here means "the binary exists" — the operator still owns getting
// it logged in.

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { getAgent, listAgents } from './agents.js';
import { loadRegistry } from './config.js';

// The executable a registered command invokes is its first whitespace-delimited
// token (`my-tool --flag` → `my-tool`). Built-in profiles already carry a bare
// `command`, so this only matters for registry entries that fold args into the
// command string.
const firstToken = (command: string): string => command.trim().split(/\s+/)[0] ?? '';

// True when `command` resolves to an executable. A command containing a path
// separator is checked as-is; a bare name is searched across PATH. Mirrors how
// the shell would resolve it before spawn() hands it to the OS.
export const isCommandAvailable = async (command: string): Promise<boolean> => {
  const cmd = firstToken(command);
  if (cmd === '') return false;

  const canExec = async (p: string): Promise<boolean> => {
    try {
      await access(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (cmd.includes('/')) return canExec(cmd);

  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (await canExec(join(dir, cmd))) return true;
  }
  return false;
};

// Resolve the underlying command for an agent name: a built-in profile's
// `command`, or a registry entry's command string. Null when the name is
// neither — the caller treats that as "not spawnable".
export const commandForAgent = async (name: string): Promise<string | null> => {
  const builtin = getAgent(name);
  if (builtin) return builtin.command;
  const registry = await loadRegistry();
  return registry.find((a) => a.name === name)?.command ?? null;
};

// Names of every agent the daemon could offer — built-ins plus registered —
// filtered to those whose command is actually installed on this host, deduped
// with built-ins taking precedence. This is the single source of truth for the
// phone launcher and the welcome message.
export const availableAgentNames = async (): Promise<string[]> => {
  const builtinNames = Object.keys(listAgents());
  const registry = await loadRegistry();
  const seen = new Set<string>();
  const candidates: Array<{ name: string; command: string }> = [];

  for (const name of builtinNames) {
    seen.add(name);
    candidates.push({ name, command: getAgent(name)!.command });
  }
  for (const entry of registry) {
    if (seen.has(entry.name)) continue; // built-in name wins
    seen.add(entry.name);
    candidates.push({ name: entry.name, command: entry.command });
  }

  const checks = await Promise.all(
    candidates.map(async (c) => ((await isCommandAvailable(c.command)) ? c.name : null))
  );
  return checks.filter((n): n is string => n !== null);
};
