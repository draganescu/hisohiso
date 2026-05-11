import { loadConfig, configExists } from '../lib/config.js';
import { createRoomAndJoin, encryptAndSend, bridgeAgentToRoom } from '../lib/room-bridge.js';
import { spawnAgent } from '../lib/agent-process.js';
import { startPresence } from '../lib/presence.js';
import { subscribeToRoom } from '../lib/sse-client.js';
import * as api from '../lib/api-client.js';
import { sha256Hex } from '../lib/crypto.js';
import qrTerminal from 'qrcode-terminal';

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

  // Create agent room
  const password = '';
  const room = await createRoomAndJoin(config.server, password);

  // Show QR code for the room
  const joinUrl = `${config.server}/room#${room.roomSecret}`;
  console.log(`\nScan to connect to ${cmd}:\n`);
  qrTerminal.generate(joinUrl, { small: true }, (code: string) => {
    console.log(code);
  });
  console.log(`\nOr open: ${joinUrl}\n`);
  console.log('Waiting for phone to join...');

  // Start presence so the room shows as active
  const presence = startPresence(config.server, room.roomHash, room.participantToken);

  // Wait for phone to knock and auto-approve
  await new Promise<void>((resolve, reject) => {
    const sse = subscribeToRoom(config.server, room.roomHash, {
      onKnock: async () => {
        console.log('Phone is joining... approving.');
        try {
          await api.approveKnock(config.server, room.roomHash, room.participantToken);
          console.log('Phone connected.');
          sse.close();
          resolve();
        } catch (err) {
          sse.close();
          reject(err);
        }
      },
      onError: (err) => {
        console.error('SSE error:', err);
      },
    });

    // Handle Ctrl+C during waiting
    const cleanup = async () => {
      console.log('\nCancelled. Cleaning up...');
      sse.close();
      presence.stop();
      try {
        await api.disbandRoom(config.server, room.roomHash, room.participantToken);
      } catch { /* best effort */ }
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
  });

  // Phone is in. Spawn the agent.
  console.log(`Spawning: ${cmd} ${args.join(' ')}`);
  const agent = await spawnAgent(cmd, args);
  console.log(`Agent running (PID: ${agent.pid}). Bridging...\n`);

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
  console.log(`\nAgent exited with code ${exit.code}`);

  // Send exit status to room
  try {
    await encryptAndSend(
      config.server,
      room.roomHash,
      room.participantToken,
      room.messageKey,
      `Agent exited with code ${exit.code}.`
    );
  } catch { /* best effort */ }

  // Cleanup
  bridge.close();
  presence.stop();
  process.exit(exit.code ?? 1);
};
