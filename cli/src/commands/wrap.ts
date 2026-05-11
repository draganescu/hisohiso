import { spawn } from 'node:child_process';
import { getServer, ensureConfigDir } from '../lib/config.js';
import { createRoomAndJoin, encryptAndSend } from '../lib/room-bridge.js';
import { startPresence } from '../lib/presence.js';
import { subscribeToRoom, type RoomEvent } from '../lib/sse-client.js';
import * as api from '../lib/api-client.js';
import { sha256Hex, decryptText, type EncryptedPayload } from '../lib/crypto.js';
import { getAgent, listAgents, type AgentProfile } from '../lib/agents.js';
import qrTerminal from 'qrcode-terminal';

const runCommand = (command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> => {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('exit', (code) => {
      resolve({ stdout, stderr, code });
    });

    child.on('error', (err) => {
      resolve({ stdout, stderr: err.message, code: 1 });
    });
  });
};

export const wrap = async (agentName: string, customCommand?: string[]): Promise<void> => {
  await ensureConfigDir();
  const server = await getServer();

  // Resolve agent profile
  let profile: AgentProfile;

  if (customCommand && customCommand.length > 0) {
    // Custom command: hisohiso wrap -- mycmd --flag
    // Message gets appended as last arg
    const [cmd, ...args] = customCommand;
    profile = { command: cmd!, args, description: 'custom command' };
  } else {
    const builtin = getAgent(agentName);
    if (!builtin) {
      console.error(`Unknown agent: "${agentName}"\n`);
      console.log('Built-in agents:');
      for (const [name, a] of Object.entries(listAgents())) {
        console.log(`  ${name.padEnd(10)} ${a.description}`);
      }
      console.log(`\nOr use a custom command: hisohiso wrap -- <command> [args...]`);
      process.exit(1);
    }
    profile = builtin;
  }

  // Create room
  const password = '';
  const room = await createRoomAndJoin(server, password);

  const joinUrl = `${server}/room#${room.roomSecret}`;
  console.log(`\nScan to connect (${agentName}):\n`);
  qrTerminal.generate(joinUrl, { small: true }, (code: string) => {
    console.log(code);
  });
  console.log(`\nOr open: ${joinUrl}\n`);
  console.log('Waiting for phone to join...');

  const presence = startPresence(server, room.roomHash, room.participantToken);

  // Wait for phone to knock and auto-approve
  await new Promise<void>((resolve, reject) => {
    const sse = subscribeToRoom(server, room.roomHash, {
      onKnock: async () => {
        try {
          await api.approveKnock(server, room.roomHash, room.participantToken);
          console.log('Phone connected.\n');
          sse.close();
          resolve();
        } catch (err) {
          sse.close();
          reject(err);
        }
      },
    });

    process.on('SIGINT', async () => {
      sse.close();
      presence.stop();
      try { await api.disbandRoom(server, room.roomHash, room.participantToken); } catch { /* */ }
      process.exit(0);
    });
  });

  // Send welcome
  await encryptAndSend(server, room.roomHash, room.participantToken, room.messageKey,
    `Connected to ${agentName}. Send a message to start.`);

  const ownTokenHash = await sha256Hex(room.participantToken);
  let running = false;

  console.log(`Listening. Messages from phone → ${profile.command} ${profile.args.join(' ')} <message>\n`);

  // Message loop: phone message → run agent → send output
  const sse = subscribeToRoom(server, room.roomHash, {
    onChat: async (event: RoomEvent) => {
      if (event.from === ownTokenHash) return;

      let text: string;
      try {
        const encPayload = typeof event.body.encrypted_payload === 'string'
          ? JSON.parse(event.body.encrypted_payload) as EncryptedPayload
          : event.body.encrypted_payload as EncryptedPayload;
        const msgId = (event.body.msg_id as string) || '';
        const decrypted = await decryptText(room.messageKey, room.roomHash, 'chat', msgId, encPayload);
        const parsed = JSON.parse(decrypted) as { text: string };
        text = parsed.text;
      } catch (err) {
        console.error('[bridge] failed to decrypt inbound:', err);
        return;
      }

      console.log(`← ${text}`);

      if (running) {
        await encryptAndSend(server, room.roomHash, room.participantToken, room.messageKey,
          'Still running previous command. Please wait.');
        return;
      }

      running = true;
      await encryptAndSend(server, room.roomHash, room.participantToken, room.messageKey,
        '...');

      // Run the agent with the user's message
      const args = [...profile.args, text];
      console.log(`  $ ${profile.command} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

      const result = await runCommand(profile.command, args);

      const output = (result.stdout || result.stderr || '(no output)').trim();
      console.log(`→ ${output.slice(0, 120)}${output.length > 120 ? '...' : ''}\n`);

      // Send output back to room — split into chunks if too long
      const MAX_MSG = 4000;
      if (output.length <= MAX_MSG) {
        await encryptAndSend(server, room.roomHash, room.participantToken, room.messageKey, output);
      } else {
        for (let i = 0; i < output.length; i += MAX_MSG) {
          const chunk = output.slice(i, i + MAX_MSG);
          await encryptAndSend(server, room.roomHash, room.participantToken, room.messageKey, chunk);
        }
      }

      if (result.code !== 0 && result.stderr) {
        await encryptAndSend(server, room.roomHash, room.participantToken, room.messageKey,
          `(exit code ${result.code})`);
      }

      running = false;
    },
    onDestroy: () => {
      console.log('Room destroyed. Exiting.');
      presence.stop();
      process.exit(0);
    },
    onOpen: () => {
      console.error('[bridge] SSE connected');
    },
    onError: (err) => {
      console.error('[bridge] SSE error:', err);
    },
  });

  // Keep alive
  await new Promise(() => {});
};
