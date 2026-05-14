import { getServer, loadActiveRooms, saveDaemonState, type DaemonState } from '../lib/config.js';
import {
  generateRoomSecret,
  deriveRoomHash,
  deriveMessageKey,
  sha256Hex,
  decryptText,
  type EncryptedPayload,
} from '../lib/crypto.js';
import * as api from '../lib/api-client.js';
import { subscribeToRoom, type RoomEvent } from '../lib/sse-client.js';
import { startPresence } from '../lib/presence.js';
import { encryptAndSend } from '../lib/room-bridge.js';
import { AgentManager } from './agent-manager.js';
import { writePid, removePid } from './pid.js';
import { listAgents } from '../lib/agents.js';
import { loadRegistry } from '../lib/config.js';
import qrTerminal from 'qrcode-terminal';

export const runDaemon = async (): Promise<void> => {
  const server = await getServer();

  // Create control room, show QR, wait for phone to join
  const { state, messageKey } = await setupControlRoom(server);
  const { controlRoomHash, controlRoomSecret, participantToken, controlRoomPassword } = state;

  await writePid(process.pid);

  const ownTokenHash = await sha256Hex(participantToken);

  const manager = new AgentManager(
    server,
    controlRoomHash,
    participantToken,
    controlRoomSecret,
    controlRoomPassword
  );

  // Start presence on control room
  const presence = startPresence(server, controlRoomHash, participantToken);

  // Check for previously active rooms (daemon restart recovery)
  const previousRooms = await loadActiveRooms();
  if (previousRooms.length > 0) {
    console.log(`Found ${previousRooms.length} previously active room(s). Sessions lost after restart.`);
    await encryptAndSend(
      server, controlRoomHash, participantToken, messageKey,
      `Daemon restarted. ${previousRooms.length} previous session(s) were lost.`,
      { handle: 'hisohiso-daemon' }
    );
  }

  // Send daemon online status with help
  await encryptAndSend(server, controlRoomHash, participantToken, messageKey,
    'Daemon online. Type an agent name to start a session (e.g. "claude", "bash"). Type "list" to see running agents or "help" for all commands.',
    { handle: 'hisohiso-daemon' }
  );

  console.log('Daemon running. Listening on control room...');

  // Listen for commands on control room
  const sse = subscribeToRoom(server, controlRoomHash, {
    onChat: async (event: RoomEvent) => {
      if (event.from === ownTokenHash) return;

      try {
        const encPayload = typeof event.body.encrypted_payload === 'string'
          ? JSON.parse(event.body.encrypted_payload) as EncryptedPayload
          : event.body.encrypted_payload as EncryptedPayload;
        const msgId = (event.body.msg_id as string) || '';
        const decrypted = await decryptText(messageKey, controlRoomHash, 'chat', msgId, encPayload);
        const parsed = JSON.parse(decrypted) as { text: string };
        const text = parsed.text.trim();
        const lower = text.toLowerCase();

        console.log(`Control: ${text}`);

        await handleCommand(lower, text, manager, server, controlRoomHash, participantToken, messageKey);
      } catch (err) {
        console.error('Failed to process message:', err);
      }
    },
    onError: (err) => {
      console.error('Control room SSE error:', typeof err === 'string' ? err : 'reconnecting...');
    },
    onOpen: () => {
      console.log('Control room SSE connected.');
    },
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down daemon...');
    sse.close();
    presence.stop();
    await manager.killAll();
    await removePid();
    await encryptAndSend(
      server, controlRoomHash, participantToken, messageKey,
      'Daemon stopped.',
      { handle: 'hisohiso-daemon' }
    ).catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

const handleCommand = async (
  lower: string,
  original: string,
  manager: AgentManager,
  server: string,
  controlRoomHash: string,
  token: string,
  messageKey: CryptoKey
): Promise<void> => {
  const reply = async (text: string, action?: { type: string; roomSecret: string; label: string }) => {
    await encryptAndSend(server, controlRoomHash, token, messageKey, text, {
      handle: 'hisohiso-daemon',
      action,
    });
  };

  try {
    // "list" — show running agents
    if (lower === 'list') {
      const agents = manager.listRunning();
      if (agents.length === 0) {
        await reply('No agents running.');
      } else {
        const lines = agents.map((a) => `${a.name} (${a.agentId})`);
        await reply(`Running agents:\n${lines.join('\n')}`);
      }
      return;
    }

    // "kill <id>" — stop an agent
    if (lower.startsWith('kill ')) {
      const id = lower.slice(5).trim();
      await manager.kill(id);
      await reply(`Agent ${id} stopped.`);
      return;
    }

    // "help" — show available commands
    if (lower === 'help') {
      const builtIn = Object.keys(listAgents());
      const registry = await loadRegistry();
      const registered = registry.map((r) => r.name);
      const all = [...new Set([...builtIn, ...registered])];
      await reply(
        `Commands:\n` +
        `  <agent>  — Start a session (${all.join(', ')})\n` +
        `  list     — Show running agents\n` +
        `  kill <id> — Stop an agent\n` +
        `  help     — This message`
      );
      return;
    }

    // Anything else — treat as agent name to spawn
    const agentName = lower.replace(/^spawn\s+/, ''); // allow "spawn claude" or just "claude"
    console.log(`Spawning agent: ${agentName}`);
    const { agentId, roomSecret } = await manager.spawn(agentName);
    console.log(`Agent spawned: ${agentName} (${agentId})`);

    await reply(`${original} session ready.`, {
      type: 'join-room',
      roomSecret,
      label: `Join ${original}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Command error: ${message}`);
    await reply(`Error: ${message}`);
  }
};

const setupControlRoom = async (server: string): Promise<{ state: DaemonState; messageKey: CryptoKey }> => {
  const password = '';
  const controlRoomSecret = generateRoomSecret();
  const controlRoomHash = await deriveRoomHash(controlRoomSecret);

  console.log('Creating control room...');
  const result = await api.createRoom(server, controlRoomHash, { catchUp: true });
  if (!result.participant_token) {
    console.error('Failed to create control room.');
    process.exit(1);
  }
  const participantToken = result.participant_token;
  const messageKey = await deriveMessageKey(controlRoomSecret, password);

  // Start presence so room shows as active
  const tempPresence = startPresence(server, controlRoomHash, participantToken);

  // Show QR
  const joinUrl = `${server}/room#${controlRoomSecret}`;
  console.log('\nScan to connect your phone to the daemon:\n');
  qrTerminal.generate(joinUrl, { small: true }, (code: string) => {
    console.log(code);
  });
  console.log(`\nOr open: ${joinUrl}\n`);
  console.log('Waiting for phone to join...');

  // Wait for knock and auto-approve
  await new Promise<void>((resolve, reject) => {
    const sse = subscribeToRoom(server, controlRoomHash, {
      onKnock: async () => {
        console.log('Phone is joining... approving.');
        try {
          await api.approveKnock(server, controlRoomHash, participantToken);
          console.log('Phone connected to control room.');
          sse.close();
          resolve();
        } catch (err) {
          sse.close();
          reject(err);
        }
      },
      onError: (err) => {
        console.error('SSE error:', typeof err === 'string' ? err : 'reconnecting...');
      },
    });

    process.on('SIGINT', async () => {
      console.log('\nCancelled. Cleaning up...');
      sse.close();
      tempPresence.stop();
      try { await api.disbandRoom(server, controlRoomHash, participantToken); } catch { /* */ }
      process.exit(0);
    });
  });

  tempPresence.stop();

  const state: DaemonState = {
    controlRoomSecret,
    controlRoomHash,
    participantToken,
    controlRoomPassword: password,
  };
  await saveDaemonState(state);

  return { state, messageKey };
};
