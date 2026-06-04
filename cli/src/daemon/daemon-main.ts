import {
  getServer,
  saveConfig,
  loadActiveRooms,
  loadDaemonState,
  saveDaemonState,
  clearDaemonState,
  clearActiveRooms,
  type DaemonState,
} from '../lib/config.js';
import { reExecSelf } from '../lib/reexec.js';
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
import { startControlServer, isControlSocketLive, DaemonAlreadyRunningError, type ControlServerHandle } from './control-server.js';
import pkg from '../../package.json' with { type: 'json' };

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
  const startTime = Date.now();

  // Single-instance guard. The control socket is an OS-enforced mutex (one
  // listener per Unix socket), far more reliable than the PID file — that's
  // last-writer-wins and only checked by the `daemon start` wrapper, so a
  // launchd service starting while a foreground daemon was still alive left two
  // daemons both subscribed to the control room, both answering every message
  // (the duplicate-reply bug). Probe before we subscribe or touch the PID file.
  if (await isControlSocketLive()) {
    // A re-exec (repair / server-move / auto-update) spawns us while the old
    // process is still finishing its ~250ms exit. That's a handoff, not a
    // duplicate: wait for the predecessor to release the socket instead of
    // refusing. A live socket with no re-exec flag is a real second instance.
    const handoff = process.env.HISOHISO_REEXEC === '1';
    let freed = false;
    if (handoff) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        if (!(await isControlSocketLive())) {
          freed = true;
          break;
        }
      }
    }
    if (!freed) {
      console.error(
        handoff
          ? 'Predecessor daemon did not release the control socket in time; exiting.'
          : 'Another hisohiso daemon is already running (control socket is live). ' +
              'This instance is exiting to avoid duplicate replies.'
      );
      return;
    }
  }
  // Don't leak the handoff flag into the long-running process or agent command envs.
  delete process.env.HISOHISO_REEXEC;

  // Initial control room — reuses saved pairing if alive server-side, else shows QR.
  let { state, messageKey } = await setupControlRoom(server);

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
  // #134 control socket — started once below, but its handlers read the live
  // `ctrl` / `state` / `manager` each call, so a re-pair that rotates the room
  // identity is transparent to the socket.
  let controlServer: ControlServerHandle | null = null;

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
    await controlServer?.close().catch(() => {});
    await removePid();
    await ctrl?.reply('Daemon stopped.').catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Resolve a parked additional-device knock for the control socket. With no id
  // and exactly one pending, resolve it; with several, require the caller to
  // disambiguate. Reuses the same handshake the in-room confirm tap drives, so
  // a terminal `hisohiso admit` and a phone tap are interchangeable.
  const resolvePending = async (
    knockMsgId: string | undefined,
    approve: boolean
  ): Promise<{ resolved: number; message: string }> => {
    if (!ctrl) throw new Error('control room is not ready yet');
    const pending = ctrl.listPendingKnocks();
    if (pending.length === 0) return { resolved: 0, message: 'No device is waiting for admission.' };
    let target = knockMsgId;
    if (!target) {
      if (pending.length > 1) {
        throw new Error(
          `${pending.length} devices waiting — pass an id: ${pending.map((p) => p.knockMsgId).join(', ')}`
        );
      }
      target = pending[0].knockMsgId;
    } else if (!pending.some((p) => p.knockMsgId === target)) {
      throw new Error(`no pending device with id ${target}`);
    }
    await ctrl.resolveControlKnock(target, approve);
    return {
      resolved: 1,
      message: approve ? 'Admitted the device to the control room.' : 'Denied the device.',
    };
  };

  // Disband every room we currently hold tokens for, on `srv`. Agent rooms come
  // from the persisted rooms.json (kept current by AgentManager); the control
  // room from live `state`. Order matters for `server <url>`: this must run on
  // the OLD server while we still hold its tokens, before the config swap.
  const disbandEverything = async (srv: string): Promise<void> => {
    const rooms = await loadActiveRooms().catch(() => []);
    const jobs: Promise<unknown>[] = [];
    for (const r of rooms) {
      if (r.participantToken) jobs.push(api.disbandRoom(srv, r.roomHash, r.participantToken).catch(() => {}));
    }
    jobs.push(api.disbandRoom(srv, state.controlRoomHash, state.participantToken).catch(() => {}));
    await Promise.all(jobs);
  };

  // Tear down this process and re-exec fresh after the socket reply has flushed.
  // We bypass the SIGTERM `shutdown` (which would try to disband the rooms we
  // just disbanded and message a dead control room); instead release resources
  // directly and re-exec carrying the knock so the boot-path re-pair is headless.
  const scheduleReExec = (carriedKnock: string): void => {
    shuttingDown = true;
    setTimeout(() => {
      clearInterval(reconcileTimer);
      currentSse?.close();
      currentPresence?.stop();
      manager.detachAll();
      void controlServer?.close().catch(() => {}).finally(() => {
        reExecSelf({ HISOHISO_CARRY_KNOCK: carriedKnock });
      });
    }, 400);
  };

  // `repair` — clean slate: disband everything on the current server, wipe local
  // state, re-exec. The boot path mints a fresh control room (reusing the knock).
  const doRepair = async (): Promise<{ message: string }> => {
    const carried = state.sessionKnockMessage;
    await disbandEverything(server);
    await clearDaemonState().catch(() => {});
    await clearActiveRooms().catch(() => {});
    scheduleReExec(carried);
    return { message: 'Repairing: disbanded all rooms; re-pairing with a fresh control room. Run `hisohiso pair` once it is back.' };
  };

  // `server <url>` — move hosts. The live rooms exist only on the OLD server and
  // can't migrate, so this is a teardown + re-pair on the new host (reusing the
  // boot path), not a hot config reload. Disband old → persist new → re-exec.
  const doServer = async (url: string): Promise<{ message: string }> => {
    if (!/^https?:\/\//.test(url)) throw new Error('server url must start with http:// or https://');
    const carried = state.sessionKnockMessage;
    await disbandEverything(server); // OLD server — tokens still valid here
    await saveConfig({ server: url });
    await clearDaemonState().catch(() => {});
    await clearActiveRooms().catch(() => {});
    scheduleReExec(carried);
    return { message: `Moving to ${url}: disbanded rooms on the old server; re-pairing there. Run \`hisohiso pair\` once it is back.` };
  };

  // Bring up the #134 control socket once. Handlers read the live refs at call
  // time. A bind failure must not take down the daemon — log and carry on
  // (the daemon still works; only the CLI control verbs are unavailable).
  controlServer = await startControlServer({
    status: () => ({
      version: pkg.version,
      uptimeMs: Date.now() - startTime,
      controlRoomHash: state.controlRoomHash,
      paired: state.controlBound === true,
      agents: manager.listRunning(),
      pendingDevices: ctrl ? ctrl.listPendingKnocks() : [],
    }),
    // Reconstruct the join material from persisted state — never the knock msg.
    pair: () => ({
      joinUrl: `${server}/room#${state.controlRoomSecret}`,
      pairingCode: state.controlRoomPassword,
      controlRoomHash: state.controlRoomHash,
    }),
    admit: (id) => resolvePending(id, true),
    deny: (id) => resolvePending(id, false),
    repair: () => doRepair(),
    server: (url) => doServer(url),
  }).catch((err) => {
    if (err instanceof DaemonAlreadyRunningError) {
      // Lost a start race against another daemon between the preflight probe and
      // binding the socket. Exit cleanly rather than running as a duplicate;
      // leave the PID file alone — the winner owns it (we never wrote ours).
      console.error('Another hisohiso daemon won the start race; this instance is exiting.');
      clearInterval(reconcileTimer);
      manager.detachAll();
      process.exit(0);
    }
    console.error('Control socket failed to start:', err instanceof Error ? err.message : err);
    return null;
  });

  // We now hold the control socket — the single-instance lock. Claim the PID
  // file (for `daemon stop`/`status`) only after the lock, so a duplicate that
  // loses the socket race never overwrites the winner's PID.
  await writePid(process.pid);

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
          // First-device-wins: the first authenticated knock binds the control
          // room and is auto-approved. A later knock (a second/unknown device
          // that learned room_secret + pairing code + sessionKnockMessage) is
          // NOT silently admitted — route it to an operator confirm tap posted
          // into THIS control room. A single-device operator who lost their
          // token recovers only via terminal `daemon start --fresh`.
          if (iterState.controlBound) {
            console.warn('Additional device knocked on a bound control room — awaiting operator confirm.');
            await iterCtrl.requestControlKnockConfirm(knockPubkey, knockMsgId);
            return;
          }
          console.log('Phone is joining... approving (control room binding to first device).');
          try {
            const binding = await beginApprove(knockPubkey, knockMsgId);
            const approveRes = await api.approveKnock(server, iterState.controlRoomHash, iterState.participantToken, binding.claimTagHash);
            const bundle = JSON.stringify({
              token: approveRes.new_participant_token,
              subscriber_jwt: approveRes.subscriber_jwt,
            });
            const wrapped = await binding.wrap(bundle);
            await api.sendWrappedToken(server, iterState.controlRoomHash, iterState.participantToken, knockMsgId, wrapped);
            iterState.controlBound = true;
            await saveDaemonState(iterState);
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

// A knock against an already-bound control room, parked until the operator taps
// confirm. Keyed by knockMsgId; expires with the lobby JWT so a never-answered
// knock is never resolved later and the map can't grow unbounded.
type PendingControlKnock = {
  knockPubkey: string;
  knockMsgId: string;
  expiresAt: number;
};

// Stale pending control-room knocks expire with the lobby JWT (~10 min,
// server/index.php LOBBY_JWT_TTL=600s).
const PENDING_CONTROL_KNOCK_TTL_MS = 10 * 60 * 1000;

// Bundles the per-iteration control-room context (server, room identity,
// message key, manager) so every send/handle stops threading five positional
// parameters by hand. Recreated each main-loop iteration because the room
// identity rotates on re-pair; the AgentManager is stable across iterations
// but its current count rides on every reply via listRunning().length.
class ControlRoom {
  // Additional-device knocks against a bound control room, awaiting the
  // operator's confirm tap (delivered as a confirm-danger block_response).
  private pendingKnocks = new Map<string, PendingControlKnock>();

  constructor(
    private readonly server: string,
    private readonly state: DaemonState,
    private readonly messageKey: CryptoKey,
    private readonly manager: AgentManager,
    private readonly suggestedName: string | null
  ) {}

  // Park an additional-device knock against a bound control room and post a
  // confirm-danger block so the operator can approve/deny it from a device that
  // is already joined. A single-device operator who lost their token cannot
  // approve here — the confirm copy points them at `daemon start --fresh`.
  async requestControlKnockConfirm(knockPubkey: string, knockMsgId: string): Promise<void> {
    // Evict already-expired parked knocks before adding this one so a flood of
    // never-answered knocks can't grow the map without bound (no timer needed).
    const nowMs = Date.now();
    for (const [k, v] of this.pendingKnocks) {
      if (nowMs > v.expiresAt) this.pendingKnocks.delete(k);
    }
    this.pendingKnocks.set(knockMsgId, {
      knockPubkey,
      knockMsgId,
      expiresAt: nowMs + PENDING_CONTROL_KNOCK_TTL_MS,
    });
    await this.reply(
      'A new device is requesting control-room access.',
      [
        buildBlock({
          type: 'confirm-danger',
          id: `confirm-routing:${knockMsgId}`,
          title: 'Admit a new device to the control room?',
          description: 'A new device is requesting control-room access. Approve only if this is you. If you lost your only device, you cannot approve from here — re-pair from the terminal with `hisohiso daemon start --fresh`.',
          confirm_label: 'Admit device',
        }),
      ]
    );
  }

  // Operator tapped the control-room confirm-danger block. Resolve the parked
  // knock: reject if unknown/expired (with an in-band notice), else run the
  // beginApprove -> approveKnock -> sendWrappedToken handshake for the control
  // room. Returns nothing; all feedback goes back into the control room.
  // Snapshot of still-valid parked knocks, for the control socket (#134) so
  // `hisohiso status` can report "N devices awaiting admission" and `hisohiso
  // admit` knows what to resolve. Expired entries are filtered out (they're
  // lazily evicted on the next requestControlKnockConfirm).
  listPendingKnocks(): Array<{ knockMsgId: string; expiresAt: number }> {
    const now = Date.now();
    const out: Array<{ knockMsgId: string; expiresAt: number }> = [];
    for (const [knockMsgId, v] of this.pendingKnocks) {
      if (now <= v.expiresAt) out.push({ knockMsgId, expiresAt: v.expiresAt });
    }
    return out;
  }

  async resolveControlKnock(knockMsgId: string, approve: boolean): Promise<void> {
    const pending = this.pendingKnocks.get(knockMsgId);
    if (!pending) {
      await this.reply('That join request is no longer pending — ask the device to knock again.');
      return;
    }
    this.pendingKnocks.delete(knockMsgId);
    if (Date.now() > pending.expiresAt) {
      await this.reply('That join request expired — ask the device to knock again.');
      return;
    }
    if (!approve) {
      await this.reply('Denied the new device.');
      return;
    }
    try {
      const binding = await beginApprove(pending.knockPubkey, pending.knockMsgId);
      const approveRes = await api.approveKnock(this.server, this.state.controlRoomHash, this.state.participantToken, binding.claimTagHash);
      const bundle = JSON.stringify({
        token: approveRes.new_participant_token,
        subscriber_jwt: approveRes.subscriber_jwt,
      });
      const wrapped = await binding.wrap(bundle);
      await api.sendWrappedToken(this.server, this.state.controlRoomHash, this.state.participantToken, pending.knockMsgId, wrapped);
      await this.reply('Admitted the new device to the control room.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.reply(`Could not admit the new device: ${msg} — ask it to knock again.`);
    }
  }

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

        // Operator answered the "admit a new device to the control room?"
        // confirm raised when an additional phone knocked on a bound control
        // room (finding #94 STEP 3). value true => run the admit handshake.
        if (type === 'confirm-danger' && block_id.startsWith('confirm-routing:')) {
          const knockMsgId = block_id.slice('confirm-routing:'.length);
          await this.resolveControlKnock(knockMsgId, value === true);
          return;
        }

        // Operator answered the "admit a new device to the <agent> room?"
        // confirm raised when an additional phone knocked on a bound agent room
        // (finding #94 STEP 4). block_id is approve-agent-knock:<agentId>:<msgId>;
        // the agentId may itself contain no ':' (it's a 12-hex slice) so split on
        // the LAST ':' to recover the msg_id.
        if (type === 'confirm-danger' && block_id.startsWith('approve-agent-knock:')) {
          const rest = block_id.slice('approve-agent-knock:'.length);
          const sep = rest.lastIndexOf(':');
          if (sep < 0) {
            await this.reply('Malformed agent-knock confirmation — ignoring.');
            return;
          }
          const agentId = rest.slice(0, sep);
          const knockMsgId = rest.slice(sep + 1);
          await this.manager.resolveAgentKnock(agentId, knockMsgId, value === true);
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

// Exported so `daemon install` can pair inline (when run interactively) without
// a separate `daemon start` — it shows the QR, waits on the knock, persists the
// control-room state, then continues to install.
export const setupControlRoom = async (
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
  // A backgrounded daemon (#125) has no TTY to scan a QR or type a knock on.
  // Gated strictly on the unit-set HISOHISO_SERVICE env so foreground behaviour
  // is byte-for-byte unchanged.
  const underService = Boolean(process.env.HISOHISO_SERVICE);

  let sessionKnockMessage: string;
  const carriedEnvKnock = process.env.HISOHISO_CARRY_KNOCK;
  if (typeof carriedKnockMessage === 'string' && carriedKnockMessage !== '') {
    sessionKnockMessage = carriedKnockMessage;
  } else if (typeof carriedEnvKnock === 'string' && carriedEnvKnock !== '') {
    // Re-exec after `repair`/`server` (#134 pt2) carries the operator's session
    // knock here so the headless re-pair doesn't prompt. Consume it once.
    sessionKnockMessage = carriedEnvKnock;
    delete process.env.HISOHISO_CARRY_KNOCK;
  } else if (underService) {
    // No carried knock and no TTY — can't pair headlessly. This shouldn't happen
    // (`daemon install` requires a prior foreground pair), but fail loudly rather
    // than hang on an invisible prompt.
    console.error('Cannot pair headlessly with no carried knock — pair once in the foreground first.');
    process.exit(1);
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

  // Headless (under a service): don't block on the first knock against a QR no
  // one can scan — that's the motivating bug. Persist an UNBOUND control room
  // and return; runDaemon's own onKnock handler binds the first authenticated
  // device, and `hisohiso pair` renders this QR on demand over the control
  // socket. `hisohiso status` reports "awaiting pairing" until a device binds.
  if (underService) {
    tempPresence.stop();
    const awaitingState: DaemonState = {
      controlRoomSecret,
      controlRoomHash,
      participantToken,
      subscriberJwt,
      controlRoomPassword: password,
      sessionKnockMessage,
      controlBound: false,
      kdfVersion: 1,
    };
    await saveDaemonState(awaitingState);
    console.log('Control room created — awaiting pairing. Run `hisohiso pair` to show the QR.');
    return { state: awaitingState, messageKey };
  }

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
    // The device we just approved above IS the first device — bind to it so any
    // subsequent knock requires an explicit operator confirm tap.
    controlBound: true,
    kdfVersion: 1,
  };
  await saveDaemonState(state);

  return { state, messageKey };
};
