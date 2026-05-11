import {
  generateRoomSecret,
  deriveRoomHash,
  deriveMessageKey,
  sha256Hex,
} from '../lib/crypto.js';
import * as api from '../lib/api-client.js';
import { subscribeToRoom } from '../lib/sse-client.js';
import { startPresence } from '../lib/presence.js';
import { encryptAndSend } from '../lib/room-bridge.js';
import { saveConfig, configExists, loadConfig, ensureConfigDir, type Config } from '../lib/config.js';
import qrTerminal from 'qrcode-terminal';

export const pair = async (server: string): Promise<void> => {
  await ensureConfigDir();

  // If already paired, disband old control room
  if (await configExists()) {
    const existing = await loadConfig();
    console.log('Existing pairing found. Disbanding old control room...');
    try {
      await api.disbandRoom(existing.server, existing.controlRoomHash, existing.participantToken);
    } catch {
      // Old room may already be gone
    }
  }

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

  // Start presence immediately
  const presence = startPresence(server, controlRoomHash, participantToken);

  // Build join URL
  const joinUrl = `${server}/room#${controlRoomSecret}`;
  console.log('\nScan this QR code on your phone to pair:\n');
  qrTerminal.generate(joinUrl, { small: true }, (code: string) => {
    console.log(code);
  });
  console.log(`\nOr open this URL: ${joinUrl}\n`);
  console.log('Waiting for phone to connect...');

  const messageKey = await deriveMessageKey(controlRoomSecret, password);
  const ownTokenHash = await sha256Hex(participantToken);

  // Wait for knock and auto-approve
  await new Promise<void>((resolve, reject) => {
    const sse = subscribeToRoom(server, controlRoomHash, {
      onKnock: async () => {
        console.log('Phone is knocking... approving.');
        try {
          await api.approveKnock(server, controlRoomHash, participantToken);
          console.log('Phone approved.');

          // Send welcome message
          await encryptAndSend(
            server,
            controlRoomHash,
            participantToken,
            messageKey,
            'Hisohiso CLI paired successfully. This is your control room.'
          );

          // Save config
          const config: Config = {
            server,
            controlRoomSecret,
            controlRoomHash,
            participantToken,
            controlRoomPassword: password,
          };
          await saveConfig(config);

          console.log('\nPaired successfully! Config saved to ~/.hisohiso/config.json');
          console.log('You can now use: hisohiso wrap -- <command>');
          console.log('Or start the daemon: hisohiso daemon start');

          sse.close();
          presence.stop();
          resolve();
        } catch (err) {
          sse.close();
          presence.stop();
          reject(err);
        }
      },
      onError: (err) => {
        console.error('SSE error:', err);
      },
    });

    // Handle Ctrl+C
    process.on('SIGINT', async () => {
      console.log('\nPairing cancelled. Cleaning up...');
      sse.close();
      presence.stop();
      try {
        await api.disbandRoom(server, controlRoomHash, participantToken);
      } catch {
        // Best effort
      }
      process.exit(0);
    });
  });
};
