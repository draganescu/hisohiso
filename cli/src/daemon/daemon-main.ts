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
import { hostname } from 'node:os';

// Suggested name the daemon stamps on every control-room envelope so the
// phone can auto-name the room on first contact. Strip mDNS `.local` (macOS
// gives us e.g. `Andreis-MacBook-Pro.local`). Empty or junk hostnames
// (`localhost`, `unknown`, blank) → null, meaning "don't stamp anything";
// the phone shows "Unnamed channel" until the user renames, which is the
// pre-feature behaviour anyway.
const suggestedControlRoomName = ((): string | null => {
  const raw = hostname().trim().replace(/\.local$/i, '');
  if (!raw) return null;
  if (raw.toLowerCase() === 'localhost') return null;
  if (raw.toLowerCase() === 'unknown') return null;
  return raw;
})();

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
  // Same mutable-ref pattern for the per-iteration ControlRoom: each re-pair
  // rotates the room identity, so we recreate the wrapper but keep a stable
  // outer binding so shutdown (set up before the first iteration) can call
  // ctrl?.reply('Daemon stopped.') against whichever iteration is current.
  let ctrl: ControlRoom | null = null;

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
    await ctrl?.reply('Daemon stopped.').catch(() => {});
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
    ctrl = new ControlRoom(server, state, messageKey, manager, suggestedControlRoomName);

    if (firstIteration) {
      if (restoreResult && restoreResult.restored > 0) {
        await ctrl.reply(`Daemon back. ${restoreResult.restored} room(s) restored — keep going.`);
      }
      if (restoreResult && restoreResult.dropped > 0) {
        await ctrl.reply(`${restoreResult.dropped} previous room(s) could not be restored:\n${restoreResult.details.join('\n')}`);
      }
    } else {
      const active = manager.listRunning().length;
      await ctrl.reply(
        active > 0
          ? `Control room re-paired. ${active} agent room(s) still active.`
          : 'Control room re-paired.'
      );
    }

    await ctrl.sendWelcome();

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
    // `state` / `messageKey` / `ctrl`) can't redirect in-flight chat decryption to the wrong room.
    const iterState = state;
    const iterKey = messageKey;
    const iterCtrl = ctrl;
    // Same k_knock the pairing flow used in setupControlRoom — re-derived here so
    // additional phones can knock and be admitted after the initial pair. Without
    // this the main loop subscribed to the room but had no knock handler, and the
    // 2nd+ device sat at "waiting for approval" forever.
    const iterKnockKey = await deriveKnockKey(iterState.controlRoomSecret, iterState.controlRoomPassword);

    await new Promise<void>((resolve) => {
      const sse = subscribeToRoom(server, iterState.controlRoomHash, iterState.subscriberJwt, {
        onKnock: async (knockEvent: RoomEvent) => {
          const knockPubkey = knockEvent.body?.knock_pubkey;
          const knockMsgId = knockEvent.body?.msg_id;
          const rawPayload = knockEvent.body?.encrypted_payload;
          if (typeof knockPubkey !== 'string' || typeof knockMsgId !== 'string' || !rawPayload) {
            console.error('Knock missing fields — ignoring.');
            return;
          }
          // Same two-gate auth as setupControlRoom and AgentManager: decrypt with
          // k_knock (proves the knocker had room_secret + pairing code), then the
          // cleartext must equal the operator's sessionKnockMessage. Either fails
          // → drop silently; the legitimate phone retries with correct inputs.
          let knockText: string;
          try {
            const enc: EncryptedPayload = typeof rawPayload === 'string'
              ? JSON.parse(rawPayload) as EncryptedPayload
              : rawPayload as EncryptedPayload;
            knockText = (await decryptText(iterKnockKey, iterState.controlRoomHash, 'knock', knockMsgId, enc)).trim();
          } catch {
            console.error('Knock decrypt failed — wrong pairing code, ignoring.');
            return;
          }
          if (knockText !== iterState.sessionKnockMessage) {
            console.error('Knock message mismatch — ignoring.');
            return;
          }
          console.log('Phone is joining... approving.');
          try {
            const binding = await beginApprove(knockPubkey, knockMsgId);
            const approveRes = await api.approveKnock(server, iterState.controlRoomHash, iterState.participantToken, binding.claimTagHash);
            const bundle = JSON.stringify({
              token: approveRes.new_participant_token,
              subscriber_jwt: approveRes.subscriber_jwt,
            });
            const wrapped = await binding.wrap(bundle);
            await api.sendWrappedToken(server, iterState.controlRoomHash, iterState.participantToken, knockMsgId, wrapped);
            console.log('Phone connected to control room.');
          } catch (err) {
            console.error('Failed to approve knock:', err);
          }
        },
        onChat: async (event: RoomEvent) => {
          if (event.from === ownTokenHash) return;

          try {
            const encPayload = typeof event.body.encrypted_payload === 'string'
              ? JSON.parse(event.body.encrypted_payload) as EncryptedPayload
              : event.body.encrypted_payload as EncryptedPayload;
            const msgId = (event.body.msg_id as string) || '';
            const decrypted = await decryptText(iterKey, iterState.controlRoomHash, 'chat', msgId, encPayload);
            type ControlBlockResponse = {
              block_id: string;
              type: string;
              value: string | number | boolean | string[];
            };
            const parsed = JSON.parse(decrypted) as {
              text: string;
              block_response?: ControlBlockResponse;
              block_responses?: ControlBlockResponse[];
            };
            const text = (parsed.text ?? '').trim();
            // The phone batches multi-block answers into block_responses; a lone
            // selection still arrives as block_response. Route each one.
            const responses: ControlBlockResponse[] =
              parsed.block_responses && parsed.block_responses.length > 0
                ? parsed.block_responses
                : parsed.block_response
                ? [parsed.block_response]
                : [];

            if (responses.length > 0) {
              for (const br of responses) {
                console.log(`Control [block ${br.block_id}]: ${JSON.stringify(br.value)}`);
              }
              for (const br of responses) {
                await iterCtrl.handleControl(br, text);
              }
            } else {
              console.log(`Control: ${text}`);
              await iterCtrl.handleControl(undefined, text);
            }
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

const launcherBlock = (agentNames: BuiltinAgentName[]): unknown => {
  // Show every available agent — built-ins + registry — in one stacked
  // list. Stacked (not inline) because >3 buttons inline wrap awkwardly on
  // narrow viewports, and the picker is short-lived so vertical real estate
  // is cheap. The previous Top-3 + "More…" two-step exists only as historical
  // optimization for the welcome message; tapping Spawn now goes straight
  // to the full list.
  return buildBlock({
    type: 'buttons',
    id: 'launcher',
    prompt: 'Start a session',
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

// Short list of evocative adjectives the daemon pairs with the agent name when
// labelling a freshly-spawned room ("Claude Velvet" instead of "Claude ·
// a3f9"). The choice is deterministic per agentId so re-broadcasting the join
// action for the same room (the daemon's `join:` rebroadcast path) reproduces
// the same name — and so the operator can develop muscle memory ("the Velvet
// session crashed"). 30 adjectives is plenty given typical session counts;
// collisions read as a feature, not a bug.
const AGENT_ADJECTIVES = [
  'Velvet', 'Neon', 'Chrome', 'Electric', 'Midnight', 'Ghost', 'Riot', 'Disco',
  'Sunset', 'Ember', 'Frost', 'Glitter', 'Static', 'Hollow', 'Lunar', 'Viper',
  'Mango', 'Plasma', 'Scarlet', 'Savage', 'Glitch', 'Paper', 'Cosmic', 'Atomic',
  'Phantom', 'Rebel', 'Vintage', 'Sapphire', 'Bionic', 'Quartz',
];
const pickAgentAdjective = (seed: string): string => {
  // djb2-ish — agentId is only ~4 chars so any reasonable mixer is fine.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AGENT_ADJECTIVES[Math.abs(h) % AGENT_ADJECTIVES.length];
};

const getAllAgentNames = async (): Promise<string[]> => {
  const builtIn = Object.keys(listAgents());
  const registry = await loadRegistry();
  const registered = registry.map((r) => r.name);
  return [...new Set([...builtIn, ...registered])];
};

// Bundles the per-iteration control-room context (server, room identity,
// message key, manager) so every send/handle stops threading five positional
// parameters by hand. Recreated each main-loop iteration because the room
// identity rotates on re-pair; the AgentManager is stable across iterations
// but its current count rides on every reply via listRunning().length.
class ControlRoom {
  constructor(
    private readonly server: string,
    private readonly state: DaemonState,
    private readonly messageKey: CryptoKey,
    private readonly manager: AgentManager,
    private readonly suggestedName: string | null
  ) {}

  // Every reply goes into the control room, so stamp `room_kind: 'control'`
  // — the phone QR-pairs the control room (no join-room action) so this
  // envelope field is the only way it learns the room's kind. `agent_count`
  // rides every reply too so the command-bar badge tracks daemon truth;
  // spawn/kill both cause a control-room message, so the count moves in
  // lockstep with reality. listRunning() is cheap (O(active-agents) on an
  // in-memory map) — call per send to avoid stale-count races.
  //
  // `room_name` is the same shape: stamped on every reply (cheap), phone
  // uses it only if no nickname is set, so once the user renames the
  // suggestion is ignored — and a late-joining or re-pairing phone still
  // gets the auto-name on its next message.
  async reply(
    text: string,
    blocks?: unknown[],
    action?: { type: string; roomSecret: string; label: string; code?: string; roomName?: string; room_kind?: 'chat' | 'control' | 'agent' }
  ): Promise<void> {
    await encryptAndSend(this.server, this.state.controlRoomHash, this.state.participantToken, this.messageKey, text, {
      handle: 'hisohiso-daemon',
      blocks,
      action,
      room_kind: 'control',
      agent_count: this.manager.listRunning().length,
      ...(this.suggestedName ? { room_name: this.suggestedName } : {}),
    });
  }

  async sendWelcome(): Promise<void> {
    const agentNames = await getAllAgentNames();
    await this.reply('Daemon online.', [launcherBlock(agentNames), helpButtonsBlock()]);
  }

  async sendList(): Promise<void> {
    // Reconcile before reading so the user-facing list is never stale. The
    // SSE-delivered destroy path is best-effort; the only authoritative
    // truth for "is this room still alive" is the server. Cheap on the
    // common path (handful of HEAD-equivalent GETs in parallel).
    await this.manager.reconcileAll();
    const agents = this.manager.listRunning();
    if (agents.length === 0) {
      await this.reply('No agents running.', [launcherBlock(await getAllAgentNames())]);
      return;
    }
    const blocks = agents.map((a) => agentRowBlock(a.agentId, a.name));
    await this.reply(`Running agents (${agents.length})`, blocks);
  }

  async sendHelp(): Promise<void> {
    const agentNames = await getAllAgentNames();
    await this.reply(
      'Tap to act — or type a command (claude / list / kill <id> / help).',
      [helpButtonsBlock(), launcherBlock(agentNames)]
    );
  }

  async spawnAndAnnounce(agentName: string): Promise<void> {
    // First ping: progress block at step 'create'. Spawn fully resolves when
    // SSE is ready, so we can't render a per-step animation without
    // instrumenting AgentManager — but two messages (spawning → ready) is
    // enough to confirm the daemon is alive while the user waits.
    await this.reply(`Spawning ${agentName}…`, [spawnProgressBlock(agentName, 'create')]);

    let result: { agentId: string; roomSecret: string; roomPassword: string };
    try {
      result = await this.manager.spawn(agentName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.reply(
        `Could not start ${agentName}: ${msg}`,
        [launcherBlock(await getAllAgentNames())]
      );
      return;
    }

    // Ready: pairing-code chip + Join action. The action drives the existing
    // join-room flow in RoomController (room navigation + local metadata
    // seed); the code block is a tap-to-copy chip for the operator to read
    // off-screen.
    const roomName = `${titleCase(agentName)} ${pickAgentAdjective(result.agentId)}`;
    await this.reply(
      `${agentName} session ready.`,
      [pairingCodeBlock(result.roomPassword)],
      {
        type: 'join-room',
        roomSecret: result.roomSecret,
        label: `Join ${agentName}`,
        code: result.roomPassword,
        roomName,
        room_kind: 'agent',
      }
    );
  }

  async handleKillRequest(agentId: string): Promise<void> {
    const agent = this.manager.listRunning().find((a) => a.agentId === agentId);
    if (!agent) {
      await this.reply(`No agent with ID ${agentId}.`);
      return;
    }
    await this.reply(`Confirm stopping ${agent.name}.`, [killConfirmBlock(agentId, agent.name)]);
  }

  async handleKillConfirmed(agentId: string): Promise<void> {
    const agent = this.manager.listRunning().find((a) => a.agentId === agentId);
    const name = agent?.name ?? 'agent';
    try {
      await this.manager.kill(agentId);
      await this.reply(`${name} (${agentId}) stopped.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.reply(`Could not stop ${agentId}: ${msg}`);
    }
  }

  async handleControl(
    blockResponse: {
      block_id: string;
      type: string;
      value: string | number | boolean | string[];
    } | undefined,
    text: string
  ): Promise<void> {
    try {
      // Route block responses first — these come from button/confirm taps
      // and carry a structured value. Text path below stays for power users
      // typing raw commands; that's also what the original protocol was.
      if (blockResponse) {
        const { block_id, type, value } = blockResponse;

        if (type === 'confirm-danger' && block_id.startsWith('kill-confirm:')) {
          const agentId = block_id.slice('kill-confirm:'.length);
          if (value === true) {
            await this.handleKillConfirmed(agentId);
          } else {
            await this.reply('Cancelled.');
          }
          return;
        }

        if (typeof value === 'string') {
          if (value === 'show-launcher') {
            await this.reply('Pick an agent.', [launcherBlock(await getAllAgentNames())]);
            return;
          }
          if (value === 'show-list') {
            await this.sendList();
            return;
          }
          if (value === 'show-help') {
            await this.sendHelp();
            return;
          }
          if (value.startsWith('spawn:')) {
            await this.spawnAndAnnounce(value.slice('spawn:'.length));
            return;
          }
          if (value.startsWith('kill:')) {
            await this.handleKillRequest(value.slice('kill:'.length));
            return;
          }
          if (value.startsWith('join:')) {
            // Re-post the ready bundle so the operator can rejoin without
            // scrolling back to the original 'session ready' message. The
            // join-room action carries the password as the pairing code chip.
            const agentId = value.slice('join:'.length);
            const info = this.manager.getRoomInfo(agentId);
            if (!info) {
              await this.reply(`No agent with ID ${agentId}.`);
              return;
            }
            await this.reply(
              `${info.name} session ready.`,
              [pairingCodeBlock(info.roomPassword)],
              {
                type: 'join-room',
                roomSecret: info.roomSecret,
                label: `Join ${info.name}`,
                code: info.roomPassword,
                roomName: `${titleCase(info.name)} ${pickAgentAdjective(agentId)}`,
                room_kind: 'agent',
              }
            );
            return;
          }
        }
      }

      // Text fallback path — keeps the original CLI grammar working for
      // users who would rather type. Lower-case match is intentional; the
      // welcome blocks include the same shortcuts as button values.
      const lower = text.toLowerCase();
      if (lower === '' && !blockResponse) return;

      if (lower === 'list') {
        await this.sendList();
        return;
      }
      if (lower.startsWith('kill ')) {
        await this.handleKillRequest(lower.slice(5).trim());
        return;
      }
      if (lower === 'help') {
        await this.sendHelp();
        return;
      }

      // Anything else — treat as agent name to spawn ("spawn claude" or just "claude")
      await this.spawnAndAnnounce(lower.replace(/^spawn\s+/, ''));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Control error: ${message}`);
      await this.reply(`Error: ${message}`);
    }
  }
}

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
    if (saved.kdfVersion !== 1) {
      // Paired under the old weak-code KDF (finding #93). Reusing it would keep
      // the weak 4-digit code alive under the new PBKDF2 derivation (still
      // offline-crackable). Force a fresh pair so a high-entropy code is minted.
      throw new Error('saved state predates KDF v1 — re-pairing to mint a high-entropy code');
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
    kdfVersion: 1,
  };
  await saveDaemonState(state);

  return { state, messageKey };
};
