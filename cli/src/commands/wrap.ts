import { loadConfig, configExists } from '../lib/config.js';
import { createRoomAndJoin, encryptAndSend, bridgeAgentToRoom } from '../lib/room-bridge.js';
import { spawnAgent } from '../lib/agent-process.js';
import { deriveMessageKey } from '../lib/crypto.js';
import { startPresence } from '../lib/presence.js';

export const wrap = async (command: string[]): Promise<void> => {
  if (!(await configExists())) {
    console.error('Not paired yet. Run: hisohiso pair --server <url>');
    process.exit(1);
  }

  const config = await loadConfig();
  const [cmd, ...args] = command;
  if (!cmd) {
    console.error('No command specified. Usage: hisohiso wrap -- <command> [args...]');
    process.exit(1);
  }

  console.log(`Creating room for: ${cmd} ${args.join(' ')}`);

  // Create agent room
  const password = '';
  const room = await createRoomAndJoin(config.server, password);

  console.log(`Room created. Hash: ${room.roomHash.slice(0, 12)}...`);

  // Notify control room about the new agent room
  const controlKey = await deriveMessageKey(config.controlRoomSecret, config.controlRoomPassword);
  const controlPresence = startPresence(config.server, config.controlRoomHash, config.participantToken);

  try {
    await encryptAndSend(
      config.server,
      config.controlRoomHash,
      config.participantToken,
      controlKey,
      JSON.stringify({
        proto: 'hisohiso-ctl',
        v: 1,
        cmd: 'spawned',
        agentId: room.roomHash.slice(0, 12),
        agent: cmd,
        roomSecret: room.roomSecret,
      })
    );
  } catch {
    // Control room notification is best-effort
  }

  console.log(`Spawning: ${cmd} ${args.join(' ')}`);

  // Spawn the agent
  const agent = await spawnAgent(cmd, args);

  console.log(`Agent running (PID: ${agent.pid}). Bridging to room...`);

  // Bridge agent to room
  const bridge = await bridgeAgentToRoom(
    agent,
    config.server,
    room.roomHash,
    room.participantToken,
    room.messageKey,
    {
      onParsedLine: (parsed) => {
        if (parsed.tag !== 'CHAT') {
          console.log(`[${parsed.tag}] ${parsed.text}`);
        }
      },
    }
  );

  // Wait for agent to exit
  const exit = await agent.onExit;
  console.log(`Agent exited with code ${exit.code}`);

  // Send exit status to room
  try {
    await encryptAndSend(
      config.server,
      room.roomHash,
      room.participantToken,
      room.messageKey,
      JSON.stringify({
        proto: 'hisohiso-ctl',
        v: 1,
        cmd: 'exited',
        agentId: room.roomHash.slice(0, 12),
        exitCode: exit.code,
      })
    );
  } catch {
    // Best effort
  }

  // Cleanup
  bridge.close();
  controlPresence.stop();
  process.exit(exit.code ?? 1);
};
