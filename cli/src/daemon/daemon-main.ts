import { loadConfig, loadActiveRooms } from '../lib/config.js';
import { deriveMessageKey, sha256Hex, decryptText, type EncryptedPayload } from '../lib/crypto.js';
import { subscribeToRoom, type RoomEvent } from '../lib/sse-client.js';
import { startPresence } from '../lib/presence.js';
import { encryptAndSend } from '../lib/room-bridge.js';
import { decodeControlMessage, type ControlCommand } from '../lib/control-protocol.js';
import { AgentManager } from './agent-manager.js';
import { writePid, removePid } from './pid.js';

export const runDaemon = async (): Promise<void> => {
  const config = await loadConfig();
  const { server, controlRoomHash, controlRoomSecret, participantToken, controlRoomPassword } = config;

  await writePid(process.pid);

  const messageKey = await deriveMessageKey(controlRoomSecret, controlRoomPassword);
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
      server,
      controlRoomHash,
      participantToken,
      messageKey,
      JSON.stringify({
        proto: 'hisohiso-ctl',
        v: 1,
        cmd: 'daemon-status',
        message: `Daemon restarted. ${previousRooms.length} previous agent(s) were lost.`,
      })
    );
  }

  // Send daemon online status
  await encryptAndSend(
    server,
    controlRoomHash,
    participantToken,
    messageKey,
    JSON.stringify({
      proto: 'hisohiso-ctl',
      v: 1,
      cmd: 'daemon-status',
      message: 'Daemon online.',
    })
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
      server,
      controlRoomHash,
      participantToken,
      messageKey,
      JSON.stringify({
        proto: 'hisohiso-ctl',
        v: 1,
        cmd: 'daemon-status',
        message: 'Daemon stopped.',
      })
    ).catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

const handleControlCommand = async (
  cmd: ControlCommand,
  manager: AgentManager,
  server: string,
  controlRoomHash: string,
  token: string,
  messageKey: CryptoKey
): Promise<void> => {
  const reply = async (msg: Record<string, unknown>) => {
    await encryptAndSend(server, controlRoomHash, token, messageKey, JSON.stringify(msg));
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
        await reply({
          proto: 'hisohiso-ctl',
          v: 1,
          cmd: 'list-reply',
          agents,
        });
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
    await reply({
      proto: 'hisohiso-ctl',
      v: 1,
      cmd: 'error',
      message,
    });
  }
};

