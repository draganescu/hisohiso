import {
  getServer,
  loadActiveRooms,
  loadDaemonState,
  saveDaemonState,
  clearDaemonState,
  type DaemonState,
} from '../lib/config.js';
import {
  generateRoomSecret,
  deriveRoomHash,
  deriveMessageKey,
  sha256Hex,
  decryptText,
  beginApprove,
  type EncryptedPayload,
} from '../lib/crypto.js';
import * as api from '../lib/api-client.js';
import { subscribeToRoom, type RoomEvent, type SSESubscription } from '../lib/sse-client.js';
import { startPresence, type PresenceHandle } from '../lib/presence.js';
import { encryptAndSend } from '../lib/room-bridge.js';
import { AgentManager, type RestoreResult } from './agent-manager.js';
import { writePid, removePid } from './pid.js';
import { startUpdateLoop } from '../lib/updater.js';
import { listAgents } from '../lib/agents.js';
import { loadRegistry } from '../lib/config.js';
import qrTerminal from 'qrcode-terminal';

export const runDaemon = async (): Promise<void> => {
  const server = await getServer();

  // Initial control room — reuses saved pairing if alive server-side, else shows QR.
  let { state, messageKey } = await setupControlRoom(server);

  await writePid(process.pid);

  const manager = new AgentManager(
    server,
    state.controlRoomHash,
    state.participantToken,
    state.controlRoomSecret,
    state.controlRoomPassword
  );

  // One-time restore of previously active agent rooms. The control room may have
  // already been reused above (no QR); the agent-room handles are independent.
  const previousRooms = await loadActiveRooms();
  let restoreResult: RestoreResult | null = null;
  if (previousRooms.length > 0) {
    console.log(`Restoring ${previousRooms.length} previously active room(s)...`);
    restoreResult = await manager.restore(previousRooms);
    console.log(`Restore: ${restoreResult.restored} restored, ${restoreResult.dropped} dropped.`);
    for (const d of restoreResult.details) console.log(`  - ${d}`);
  }

  // Mutable refs so the single shutdown handler always sees the current iteration's
  // control-room SSE + presence (they swap when the phone disbands the control room).
  let currentSse: SSESubscription | null = null;
  let currentPresence: PresenceHandle | null = null;
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down daemon...');
    currentSse?.close();
    currentPresence?.stop();
    manager.detachAll();
    await removePid();
    await encryptAndSend(
      server, state.controlRoomHash, state.participantToken, messageKey,
      'Daemon stopped.',
      { handle: 'hisohiso-daemon' }
    ).catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Re-pair loop: each iteration owns one control-room lifecycle. The phone disbanding
  // the control room resolves the iteration's promise and we re-pair (fresh QR), keeping
  // agent rooms running across the swap.
  let firstIteration = true;
  while (true) {
    if (!firstIteration) {
      await clearDaemonState().catch(() => {});
      console.log('Control room was disbanded by phone — re-pairing.');
      ({ state, messageKey } = await setupControlRoom(server));
      manager.updateControlRoom(
        state.controlRoomHash,
        state.participantToken,
        state.controlRoomSecret,
        state.controlRoomPassword
      );
    }

    const ownTokenHash = await sha256Hex(state.participantToken);
    currentPresence = startPresence(server, state.controlRoomHash, state.participantToken);

    if (firstIteration) {
      if (restoreResult && restoreResult.restored > 0) {
        await encryptAndSend(
          server, state.controlRoomHash, state.participantToken, messageKey,
          `Daemon back. ${restoreResult.restored} room(s) restored — keep going.`,
          { handle: 'hisohiso-daemon' }
        );
      }
      if (restoreResult && restoreResult.dropped > 0) {
        await encryptAndSend(
          server, state.controlRoomHash, state.participantToken, messageKey,
          `${restoreResult.dropped} previous room(s) could not be restored:\n${restoreResult.details.join('\n')}`,
          { handle: 'hisohiso-daemon' }
        );
      }
    } else {
      const active = manager.listRunning().length;
      await encryptAndSend(
        server, state.controlRoomHash, state.participantToken, messageKey,
        active > 0
          ? `Control room re-paired. ${active} agent room(s) still active.`
          : 'Control room re-paired.',
        { handle: 'hisohiso-daemon' }
      );
    }

    await encryptAndSend(server, state.controlRoomHash, state.participantToken, messageKey,
      'Daemon online. Type an agent name to start a session (e.g. "claude", "codex", "bash"). Type "list" to see running agents or "help" for all commands.',
      { handle: 'hisohiso-daemon' }
    );

    console.log('Daemon running. Listening on control room...');

    // Sparkle-style auto-updater. Ticks every 6h (first tick delayed 30 min
    // by the helper). Only swaps the binary when no agent session is mid-
    // turn. Opt out with HISOHISO_AUTO_UPDATE=off. Daemon state is already
    // persisted via saveDaemonState() at setup, so the re-exec'd daemon
    // re-attaches to every active room on next boot.
    startUpdateLoop({
      isIdle: () => manager.isIdle(),
      log: (m) => console.log(`[updater] ${m}`),
    });

    // Freeze the values the SSE handlers close over so a later re-pair (which reassigns
    // `state` / `messageKey`) can't redirect in-flight chat decryption to the wrong room.
    const iterState = state;
    const iterKey = messageKey;

    await new Promise<void>((resolve) => {
      const sse = subscribeToRoom(server, iterState.controlRoomHash, iterState.subscriberJwt, {
        onChat: async (event: RoomEvent) => {
          if (event.from === ownTokenHash) return;

          try {
            const encPayload = typeof event.body.encrypted_payload === 'string'
              ? JSON.parse(event.body.encrypted_payload) as EncryptedPayload
              : event.body.encrypted_payload as EncryptedPayload;
            const msgId = (event.body.msg_id as string) || '';
            const decrypted = await decryptText(iterKey, iterState.controlRoomHash, 'chat', msgId, encPayload);
            const parsed = JSON.parse(decrypted) as { text: string };
            const text = parsed.text.trim();
            const lower = text.toLowerCase();

            console.log(`Control: ${text}`);

            await handleCommand(lower, text, manager, server, iterState.controlRoomHash, iterState.participantToken, iterKey);
          } catch (err) {
            console.error('Failed to process message:', err);
          }
        },
        onDestroy: () => {
          sse.close();
          currentPresence?.stop();
          currentSse = null;
          currentPresence = null;
          resolve();
        },
        onError: (err) => {
          console.error('Control room SSE error:', typeof err === 'string' ? err : 'reconnecting...');
        },
        onOpen: () => {
          console.log('Control room SSE connected.');
        },
      });
      currentSse = sse;
    });

    firstIteration = false;
  }
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
  // Try to reuse a previously-paired control room. If daemon-state.json exists and
  // the room is still alive server-side, the phone is already paired — no QR rescan
  // needed across daemon restarts. Falls through to creating a fresh control room if
  // there's no saved state or the saved room is gone.
  try {
    const saved = await loadDaemonState();
    await api.checkRoom(server, saved.controlRoomHash);
    console.log('Reusing previously paired control room (no QR scan needed).');
    const messageKey = await deriveMessageKey(saved.controlRoomSecret, saved.controlRoomPassword);
    return { state: saved, messageKey };
  } catch {
    // No saved state, or saved room has been disbanded server-side. Fall through.
  }

  const password = '';
  const controlRoomSecret = generateRoomSecret();
  const controlRoomHash = await deriveRoomHash(controlRoomSecret);

  console.log('Creating control room...');
  const result = await api.createRoom(server, controlRoomHash, { catchUp: true });
  if (!result.participant_token || !result.subscriber_jwt) {
    console.error('Failed to create control room (no token or subscriber_jwt).');
    process.exit(1);
  }
  const participantToken = result.participant_token;
  const subscriberJwt = result.subscriber_jwt;
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

  // Pairing-only cancel handler. Critical that it's removed once pairing settles —
  // an earlier version left this attached for the daemon's whole lifetime, so the next
  // Ctrl+C disbanded the live control room (and forced a QR rescan on every restart).
  const cancelPairing = async (): Promise<void> => {
    console.log('\nCancelled. Cleaning up...');
    try { await api.disbandRoom(server, controlRoomHash, participantToken); } catch { /* */ }
    process.exit(0);
  };
  process.on('SIGINT', cancelPairing);

  try {
    await new Promise<void>((resolve, reject) => {
      const sse = subscribeToRoom(server, controlRoomHash, subscriberJwt, {
        onKnock: async (knockEvent: RoomEvent) => {
          console.log('Phone is joining... approving.');
          const knockPubkey = knockEvent.body?.knock_pubkey;
          const knockMsgId = knockEvent.body?.msg_id;
          if (typeof knockPubkey !== 'string' || typeof knockMsgId !== 'string') {
            console.error('Knock missing knock_pubkey or msg_id — ignoring.');
            return;
          }
          try {
            const binding = await beginApprove(knockPubkey, knockMsgId);
            const approveRes = await api.approveKnock(server, controlRoomHash, participantToken, binding.claimTagHash);
            const bundle = JSON.stringify({
              token: approveRes.new_participant_token,
              subscriber_jwt: approveRes.subscriber_jwt,
            });
            const wrapped = await binding.wrap(bundle);
            await api.sendWrappedToken(server, controlRoomHash, participantToken, knockMsgId, wrapped);
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
    });
  } finally {
    process.off('SIGINT', cancelPairing);
    tempPresence.stop();
  }

  const state: DaemonState = {
    controlRoomSecret,
    controlRoomHash,
    participantToken,
    subscriberJwt,
    controlRoomPassword: password,
  };
  await saveDaemonState(state);

  return { state, messageKey };
};
