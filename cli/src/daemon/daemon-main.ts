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
import { promptLine, generatePairingCode } from '../lib/prompt.js';
import { deriveKnockKey } from '../lib/crypto.js';
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
    state.controlRoomPassword,
    state.sessionKnockMessage
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

  // Periodic reconciliation against the server. Catches silent SSE death,
  // missed destroy events, and any other failure mode where local in-memory
  // session state drifts from server truth. Five-minute cadence is a
  // tradeoff: tight enough that ghost agents disappear before the next
  // operator interaction, loose enough that we're not hammering the API.
  const reconcileTimer = setInterval(() => {
    void manager.reconcileAll().then((result) => {
      if (result.cleaned.length > 0) {
        console.log(`Background reconcile: cleaned ${result.cleaned.length} ghost session(s) [${result.cleaned.join(', ')}]`);
      }
    }).catch((err) => {
      console.error('Background reconcile failed:', err);
    });
  }, 5 * 60 * 1000);

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down daemon...');
    clearInterval(reconcileTimer);
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
      // Re-pair after the phone disbanded the control room. Carry the session
      // knock message into the new pair — it's the operator's session secret,
      // not a per-room thing, and re-prompting after every re-pair would be
      // hostile UX. clearDaemonState wipes the now-dead saved state so the
      // freshly minted controlRoomPassword / hash get persisted cleanly.
      const carriedKnockMessage = state.sessionKnockMessage;
      await clearDaemonState().catch(() => {});
      console.log('Control room was disbanded by phone — re-pairing.');
      ({ state, messageKey } = await setupControlRoom(server, carriedKnockMessage));
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

    await sendWelcome(server, state.controlRoomHash, state.participantToken, messageKey);

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
            const parsed = JSON.parse(decrypted) as {
              text: string;
              block_response?: {
                block_id: string;
                type: string;
                value: string | number | boolean | string[];
              };
            };
            const text = (parsed.text ?? '').trim();

            if (parsed.block_response) {
              console.log(`Control [block ${parsed.block_response.block_id}]: ${JSON.stringify(parsed.block_response.value)}`);
            } else {
              console.log(`Control: ${text}`);
            }

            await handleControl(parsed.block_response, text, manager, server, iterState.controlRoomHash, iterState.participantToken, iterKey);
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

// Block-id conventions used as routing keys for block_response values. The
// phone tap on a button posts { value: 'spawn:claude' } back; the daemon
// dispatches on the prefix. Keeping these as string literals (not enums) so
// the round-trip is plain JSON the phone already handles.
//   show-launcher | show-list | show-help
//   spawn:<agent>
//   join:<agentId>            (handled inline — re-posts ready bundle)
//   kill:<agentId>            (-> confirm-danger block kill-confirm:<agentId>)
//   kill-confirm:<agentId>    (boolean response)
type BuiltinAgentName = string;

const buildBlock = <T extends Record<string, unknown>>(b: T): T => b;

const replyBlocks = async (
  server: string,
  controlRoomHash: string,
  token: string,
  messageKey: CryptoKey,
  text: string,
  blocks?: unknown[],
  action?: { type: string; roomSecret: string; label: string; code?: string; roomName?: string }
): Promise<void> => {
  await encryptAndSend(server, controlRoomHash, token, messageKey, text, {
    handle: 'hisohiso-daemon',
    blocks,
    action,
  });
};

const launcherBlock = (agentNames: BuiltinAgentName[]): unknown => {
  // Show up to 3 first-class agents inline; the rest go behind a "More…"
  // expansion via show-launcher:all. Keeps the welcome compact.
  const PRIMARY = ['claude', 'codex', 'bash'];
  const primary = PRIMARY.filter((n) => agentNames.includes(n));
  const others = agentNames.filter((n) => !primary.includes(n));
  const options = primary.map((name) => ({ label: titleCase(name), value: `spawn:${name}` }));
  if (others.length > 0) {
    options.push({ label: `More… (${others.length})`, value: 'show-launcher:all' });
  }
  return buildBlock({
    type: 'buttons',
    id: 'launcher',
    prompt: 'Start a session',
    style: 'inline',
    multi: false,
    options,
  });
};

const allAgentsBlock = (agentNames: BuiltinAgentName[]): unknown => {
  return buildBlock({
    type: 'buttons',
    id: 'launcher-all',
    prompt: 'All agents',
    style: 'stacked',
    multi: false,
    options: agentNames.map((name) => ({ label: titleCase(name), value: `spawn:${name}` })),
  });
};

const helpButtonsBlock = (): unknown => {
  return buildBlock({
    type: 'buttons',
    id: 'help',
    prompt: 'Quick actions',
    style: 'inline',
    multi: false,
    options: [
      { label: 'Start session', value: 'show-launcher' },
      { label: 'List running', value: 'show-list' },
      { label: 'Help', value: 'show-help' },
    ],
  });
};

const agentRowBlock = (agentId: string, name: string): unknown => {
  // One buttons block per running agent. prompt carries the name + id so the
  // operator can tell which is which without typing the id. Values embed the
  // id so the round-trip needs no extra state.
  return buildBlock({
    type: 'buttons',
    id: `agent-row:${agentId}`,
    prompt: `${name} · ${agentId}`,
    style: 'inline',
    multi: false,
    options: [
      { label: 'Join', value: `join:${agentId}` },
      { label: 'Stop', value: `kill:${agentId}` },
    ],
  });
};

const killConfirmBlock = (agentId: string, name: string): unknown => {
  return buildBlock({
    type: 'confirm-danger',
    id: `kill-confirm:${agentId}`,
    title: `Stop ${name} (${agentId})?`,
    description: 'Session state is lost. The agent room stays open; spawned shells inside it are terminated.',
    confirm_label: 'Stop agent',
  });
};

const pairingCodeBlock = (code: string): unknown => {
  return buildBlock({
    type: 'code',
    file: 'pairing code',
    language: 'text',
    content: code,
  });
};

const spawnProgressBlock = (agentName: string, atStep: 'create' | 'sse' | 'ready'): unknown => {
  const order: Array<'create' | 'sse' | 'ready'> = ['create', 'sse', 'ready'];
  const idx = order.indexOf(atStep);
  return buildBlock({
    type: 'progress',
    title: `Spawning ${agentName}…`,
    steps: [
      { label: 'Mint room + derive keys', status: idx > 0 ? 'done' : 'active' },
      { label: 'Connect SSE', status: idx > 1 ? 'done' : idx === 1 ? 'active' : 'pending' },
      { label: 'Ready to join', status: idx >= 2 ? 'done' : 'pending' },
    ],
  });
};

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const sendWelcome = async (
  server: string,
  controlRoomHash: string,
  token: string,
  messageKey: CryptoKey
): Promise<void> => {
  const agentNames = await getAllAgentNames();
  await replyBlocks(
    server, controlRoomHash, token, messageKey,
    'Daemon online.',
    [launcherBlock(agentNames), helpButtonsBlock()]
  );
};

const getAllAgentNames = async (): Promise<string[]> => {
  const builtIn = Object.keys(listAgents());
  const registry = await loadRegistry();
  const registered = registry.map((r) => r.name);
  return [...new Set([...builtIn, ...registered])];
};

const sendList = async (
  manager: AgentManager,
  server: string,
  controlRoomHash: string,
  token: string,
  messageKey: CryptoKey
): Promise<void> => {
  // Reconcile before reading so the user-facing list is never stale. The
  // SSE-delivered destroy path is best-effort; the only authoritative
  // truth for "is this room still alive" is the server. Cheap on the
  // common path (handful of HEAD-equivalent GETs in parallel).
  await manager.reconcileAll();
  const agents = manager.listRunning();
  if (agents.length === 0) {
    await replyBlocks(
      server, controlRoomHash, token, messageKey,
      'No agents running.',
      [launcherBlock(await getAllAgentNames())]
    );
    return;
  }
  const blocks = agents.map((a) => agentRowBlock(a.agentId, a.name));
  await replyBlocks(
    server, controlRoomHash, token, messageKey,
    `Running agents (${agents.length})`,
    blocks
  );
};

const sendHelp = async (
  server: string,
  controlRoomHash: string,
  token: string,
  messageKey: CryptoKey
): Promise<void> => {
  const agentNames = await getAllAgentNames();
  await replyBlocks(
    server, controlRoomHash, token, messageKey,
    'Tap to act — or type a command (claude / list / kill <id> / help).',
    [helpButtonsBlock(), launcherBlock(agentNames)]
  );
};

const spawnAndAnnounce = async (
  agentName: string,
  manager: AgentManager,
  server: string,
  controlRoomHash: string,
  token: string,
  messageKey: CryptoKey
): Promise<void> => {
  // First ping: progress block at step 'create'. Spawn fully resolves when SSE
  // is ready, so we can't render a per-step animation without instrumenting
  // AgentManager — but two messages (spawning → ready) is enough to confirm
  // the daemon is alive while the user waits.
  await replyBlocks(
    server, controlRoomHash, token, messageKey,
    `Spawning ${agentName}…`,
    [spawnProgressBlock(agentName, 'create')]
  );

  let result: { agentId: string; roomSecret: string; roomPassword: string };
  try {
    result = await manager.spawn(agentName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await replyBlocks(
      server, controlRoomHash, token, messageKey,
      `Could not start ${agentName}: ${msg}`,
      [launcherBlock(await getAllAgentNames())]
    );
    return;
  }

  // Ready: pairing-code chip + Join action. The action drives the existing
  // join-room flow in RoomController (room navigation + local metadata seed);
  // the code block is a tap-to-copy chip for the operator to read off-screen.
  const roomName = `${titleCase(agentName)} · ${result.agentId}`;
  await replyBlocks(
    server, controlRoomHash, token, messageKey,
    `${agentName} session ready.`,
    [pairingCodeBlock(result.roomPassword)],
    {
      type: 'join-room',
      roomSecret: result.roomSecret,
      label: `Join ${agentName}`,
      code: result.roomPassword,
      roomName,
    }
  );
};

const handleKillRequest = async (
  agentId: string,
  manager: AgentManager,
  server: string,
  controlRoomHash: string,
  token: string,
  messageKey: CryptoKey
): Promise<void> => {
  const agent = manager.listRunning().find((a) => a.agentId === agentId);
  if (!agent) {
    await replyBlocks(
      server, controlRoomHash, token, messageKey,
      `No agent with ID ${agentId}.`
    );
    return;
  }
  await replyBlocks(
    server, controlRoomHash, token, messageKey,
    `Confirm stopping ${agent.name}.`,
    [killConfirmBlock(agentId, agent.name)]
  );
};

const handleKillConfirmed = async (
  agentId: string,
  manager: AgentManager,
  server: string,
  controlRoomHash: string,
  token: string,
  messageKey: CryptoKey
): Promise<void> => {
  const agent = manager.listRunning().find((a) => a.agentId === agentId);
  const name = agent?.name ?? 'agent';
  try {
    await manager.kill(agentId);
    await replyBlocks(
      server, controlRoomHash, token, messageKey,
      `${name} (${agentId}) stopped.`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await replyBlocks(
      server, controlRoomHash, token, messageKey,
      `Could not stop ${agentId}: ${msg}`
    );
  }
};

const handleControl = async (
  blockResponse: {
    block_id: string;
    type: string;
    value: string | number | boolean | string[];
  } | undefined,
  text: string,
  manager: AgentManager,
  server: string,
  controlRoomHash: string,
  token: string,
  messageKey: CryptoKey
): Promise<void> => {
  try {
    // Route block responses first — these come from button/confirm taps and
    // carry a structured value. Text path below stays for power users typing
    // raw commands; that's also what the original protocol was.
    if (blockResponse) {
      const { block_id, type, value } = blockResponse;

      if (type === 'confirm-danger' && block_id.startsWith('kill-confirm:')) {
        const agentId = block_id.slice('kill-confirm:'.length);
        if (value === true) {
          await handleKillConfirmed(agentId, manager, server, controlRoomHash, token, messageKey);
        } else {
          await replyBlocks(server, controlRoomHash, token, messageKey, 'Cancelled.');
        }
        return;
      }

      if (typeof value === 'string') {
        if (value === 'show-launcher') {
          const names = await getAllAgentNames();
          await replyBlocks(server, controlRoomHash, token, messageKey, 'Pick an agent.', [launcherBlock(names)]);
          return;
        }
        if (value === 'show-launcher:all') {
          const names = await getAllAgentNames();
          await replyBlocks(server, controlRoomHash, token, messageKey, 'All agents.', [allAgentsBlock(names)]);
          return;
        }
        if (value === 'show-list') {
          await sendList(manager, server, controlRoomHash, token, messageKey);
          return;
        }
        if (value === 'show-help') {
          await sendHelp(server, controlRoomHash, token, messageKey);
          return;
        }
        if (value.startsWith('spawn:')) {
          const agentName = value.slice('spawn:'.length);
          await spawnAndAnnounce(agentName, manager, server, controlRoomHash, token, messageKey);
          return;
        }
        if (value.startsWith('kill:')) {
          const agentId = value.slice('kill:'.length);
          await handleKillRequest(agentId, manager, server, controlRoomHash, token, messageKey);
          return;
        }
        if (value.startsWith('join:')) {
          // Re-post the ready bundle so the operator can rejoin without
          // scrolling back to the original 'session ready' message. The
          // join-room action carries the password as the pairing code chip.
          const agentId = value.slice('join:'.length);
          const info = manager.getRoomInfo(agentId);
          if (!info) {
            await replyBlocks(server, controlRoomHash, token, messageKey, `No agent with ID ${agentId}.`);
            return;
          }
          await replyBlocks(
            server, controlRoomHash, token, messageKey,
            `${info.name} session ready.`,
            [pairingCodeBlock(info.roomPassword)],
            {
              type: 'join-room',
              roomSecret: info.roomSecret,
              label: `Join ${info.name}`,
              code: info.roomPassword,
              roomName: `${titleCase(info.name)} · ${agentId}`,
            }
          );
          return;
        }
      }
    }

    // Text fallback path — keeps the original CLI grammar working for users
    // who would rather type. Note: lower-case match is intentional, the
    // welcome blocks include the same shortcuts as button values.
    const lower = text.toLowerCase();
    if (lower === '' && !blockResponse) return;

    if (lower === 'list') {
      await sendList(manager, server, controlRoomHash, token, messageKey);
      return;
    }
    if (lower.startsWith('kill ')) {
      const id = lower.slice(5).trim();
      await handleKillRequest(id, manager, server, controlRoomHash, token, messageKey);
      return;
    }
    if (lower === 'help') {
      await sendHelp(server, controlRoomHash, token, messageKey);
      return;
    }

    // Anything else — treat as agent name to spawn (allow "spawn claude" or just "claude")
    const agentName = lower.replace(/^spawn\s+/, '');
    await spawnAndAnnounce(agentName, manager, server, controlRoomHash, token, messageKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Control error: ${message}`);
    await replyBlocks(server, controlRoomHash, token, messageKey, `Error: ${message}`);
  }
};

const setupControlRoom = async (
  server: string,
  carriedKnockMessage?: string
): Promise<{ state: DaemonState; messageKey: CryptoKey }> => {
  // Reuse a previously-paired control room if alive server-side. This carries
  // the persisted controlRoomPassword AND sessionKnockMessage forward across
  // daemon restarts (including auto-update re-execs), so the phone keeps
  // working with the same code + knock-msg it was paired with originally.
  try {
    const saved = await loadDaemonState();
    await api.checkRoom(server, saved.controlRoomHash);
    if (typeof saved.sessionKnockMessage !== 'string' || saved.sessionKnockMessage === '') {
      // Pre-pairing-code state — too risky to reuse silently. Treat as if
      // there were no saved state, which forces a fresh pair below.
      throw new Error('saved state predates pairing-code release');
    }
    console.log('Reusing previously paired control room (no QR scan needed).');
    const messageKey = await deriveMessageKey(saved.controlRoomSecret, saved.controlRoomPassword);
    return { state: saved, messageKey };
  } catch {
    // No saved state, the saved room has been disbanded server-side, or the
    // saved state is from a pre-pairing-code daemon. Fall through to fresh pair.
  }

  // Operator-typed session knock message. Hidden input so it doesn't show up
  // in scrollback / screenshots. Persisted via DaemonState below; the same
  // string is the expected knock cleartext for every agent room minted later.
  // A re-pair carries the existing knockMessage forward — no re-prompt.
  let sessionKnockMessage: string;
  if (typeof carriedKnockMessage === 'string' && carriedKnockMessage !== '') {
    sessionKnockMessage = carriedKnockMessage;
  } else {
    sessionKnockMessage = (await promptLine('Session knock message (used to authenticate every join in this session): ', { hidden: true })).trim();
    if (sessionKnockMessage === '') {
      console.error('Knock message cannot be empty. Aborting.');
      process.exit(1);
    }
  }

  const password = generatePairingCode();
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
  const knockKey = await deriveKnockKey(controlRoomSecret, password);

  // Start presence so room shows as active
  const tempPresence = startPresence(server, controlRoomHash, participantToken);

  // Show QR + pairing code together. The phone scans QR for room_secret;
  // operator reads the pairing code off this terminal and types it as the
  // password on the phone's join screen. The knock message stays in the
  // operator's head — never displayed.
  const joinUrl = `${server}/room#${controlRoomSecret}`;
  console.log('\nScan to connect your phone to the daemon:\n');
  qrTerminal.generate(joinUrl, { small: true }, (code: string) => {
    console.log(code);
  });
  console.log(`\nOr open: ${joinUrl}`);
  console.log(`Pairing code: ${password}`);
  console.log('(Enter the pairing code as the room password; use your session knock message as the knock body.)\n');
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
          const knockPubkey = knockEvent.body?.knock_pubkey;
          const knockMsgId = knockEvent.body?.msg_id;
          const rawPayload = knockEvent.body?.encrypted_payload;
          if (typeof knockPubkey !== 'string' || typeof knockMsgId !== 'string' || !rawPayload) {
            console.error('Knock missing fields — ignoring.');
            return;
          }
          // Decrypt the knock body with k_knock; if that fails the phone
          // didn't use the right pairing code. Then compare the cleartext to
          // the operator's session knock message; if those differ, drop.
          // Either path: do NOT approve. The legitimate phone retries with
          // correct inputs; brute-forcers see nothing actionable.
          let knockText: string;
          try {
            const enc = typeof rawPayload === 'string'
              ? JSON.parse(rawPayload) as EncryptedPayload
              : rawPayload as EncryptedPayload;
            knockText = (await decryptText(knockKey, controlRoomHash, 'knock', knockMsgId, enc)).trim();
          } catch {
            console.error('Knock decrypt failed — wrong pairing code, ignoring.');
            return;
          }
          if (knockText !== sessionKnockMessage) {
            console.error('Knock message mismatch — ignoring.');
            return;
          }
          console.log('Phone is joining... approving.');
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
    sessionKnockMessage,
  };
  await saveDaemonState(state);

  return { state, messageKey };
};
