import { loadConfig, loadActiveRooms, loadDaemonState, saveDaemonState, type DaemonState } from '../lib/config.js';
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
import { decodeControlMessage, type ControlCommand } from '../lib/control-protocol.js';
import { AgentManager } from './agent-manager.js';
import { writePid, removePid } from './pid.js';
import qrTerminal from 'qrcode-terminal';

export const runDaemon = async (): Promise<void> => {
  const config = await loadConfig();
  const { server } = config;

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
    console.log(`Found ${previousRooms.length} previously active room(s). Agents are lost after restart.`);
    await encryptAndSend(
      server, controlRoomHash, participantToken, messageKey,
      `Daemon restarted. ${previousRooms.length} previous agent(s) were lost.`
    );
  }

  // Send daemon online status
  await encryptAndSend(server, controlRoomHash, participantToken, messageKey, 'Daemon online.');

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
        const text = parsed.text;

        const ctrl = decodeControlMessage(text);
        if (!ctrl) {
          console.log(`Chat from phone: ${text}`);
          return;
        }

        await handleControlCommand(ctrl as ControlCommand, manager, server, controlRoomHash, participantToken, messageKey);
      } catch (err) {
        console.error('Failed to process message:', err);
      }
    },
    onError: (err) => {
      console.error('Control room SSE error:', err);
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
      'Daemon stopped.'
    ).catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

const setupControlRoom = async (server: string): Promise<{ state: DaemonState; messageKey: CryptoKey }> => {
  const password = '';
  const controlRoomSecret = generateRoomSecret();
  const controlRoomHash = await deriveRoomHash(controlRoomSecret);

  console.log('Creating control room...');
  const result = await api.createRoom(server, controlRoomHash);
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
        console.error('SSE error:', err);
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

const handleControlCommand = async (
  cmd: ControlCommand,
  manager: AgentManager,
  server: string,
  controlRoomHash: string,
  token: string,
  messageKey: CryptoKey
): Promise<void> => {
  const reply = async (text: string) => {
    await encryptAndSend(server, controlRoomHash, token, messageKey, text);
  };

  try {
    switch (cmd.cmd) {
      case 'spawn': {
        console.log(`Spawning agent: ${cmd.agent}`);
        const agentId = await manager.spawn(cmd.agent, cmd.initialMessage);
        console.log(`Agent spawned: ${agentId}`);
        break;
      }
      case 'kill': {
        console.log(`Killing agent: ${cmd.agentId}`);
        await manager.kill(cmd.agentId);
        break;
      }
      case 'list': {
        const agents = manager.listRunning();
        await reply(JSON.stringify({
          proto: 'hisohiso-ctl', v: 1, cmd: 'list-reply', agents,
        }));
        break;
      }
      case 'input': {
        await manager.sendInput(cmd.agentId, cmd.text);
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Command error: ${message}`);
    await reply(JSON.stringify({
      proto: 'hisohiso-ctl', v: 1, cmd: 'error', message,
    }));
  }
};
