import {
  getServer,
  saveConfig,
  loadActiveRooms,
  loadDaemonState,
  saveDaemonState,
  clearDaemonState,
  clearActiveRooms,
  loadSchedules,
  saveSchedules,
  type DaemonState,
} from '../lib/config.js';
import { Scheduler, parseCron, type Schedule } from '../lib/scheduler.js';
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
import { jwtExpiresWithin, SUBSCRIBER_JWT_REFRESH_MARGIN_MS } from '../lib/jwt.js';
import { startPresence, type PresenceHandle } from '../lib/presence.js';
import { encryptAndSend } from '../lib/room-bridge.js';
import { AgentManager, type RestoreResult } from './agent-manager.js';
import { writePid, removePid } from './pid.js';
import { startUpdateLoop } from '../lib/updater.js';
import { promptLine, generatePairingCode } from '../lib/prompt.js';
import { deriveKnockKey } from '../lib/crypto.js';
import { availableAgentNames } from '../lib/agent-detect.js';
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

  // #232 daemon-owned scheduler. Constructed once; each fire reads the live
  // `ctrl` (mutable — rotates on re-pair) so a re-pair is transparent. An
  // ephemeral fire runs the agent headless and posts a summary into the control
  // room; on failure it notifies (unless opted out) and rethrows so the
  // scheduler records the failed status.
  const scheduler = new Scheduler({
    fire: async (s: Schedule) => {
      const c = ctrl;
      try {
        // runEphemeral parses the agent's block-JSON into { text, blocks }, so the
        // control room renders blocks instead of raw JSON (the body is the text).
        const { text, blocks } = await manager.runEphemeral(s.agent, s.prompt, { timeoutMs: s.timeoutMs });
        const body = text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
        await c?.reply(`⏰ ${s.name} — done${body ? `\n\n${body}` : ''}`, blocks);
      } catch (err) {
        if (s.notifyOnError) {
          await c?.reply(`⏰ ${s.name} — failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
        }
        throw err;
      }
    },
    persist: saveSchedules,
    log: (m) => console.log(`[scheduler] ${m}`),
  });
  scheduler.load(await loadSchedules());

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
    scheduler.stop();
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

  // `restart` — plain in-place recycle, NO teardown: daemon-state.json and
  // rooms.json stay, so the boot path reuses the paired control room and
  // re-attaches agent rooms (same guarantees as the auto-updater's re-exec).
  // Carrying the knock is only a safety net for the edge where the saved
  // control room turns out dead and the boot path has to re-pair.
  const doRestart = async (): Promise<{ message: string }> => {
    scheduleReExec(state.sessionKnockMessage);
    return { message: 'Restarting in place — pairing and agent rooms preserved. `hisohiso daemon status` in a few seconds to confirm.' };
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

  // `notify <text>` — the host's channel into the control room. Local automation
  // (cron, health checks, deploy hooks) connects to the owner-only socket and the
  // daemon posts the text as a normal control-room message, so it lands on the
  // paired phone. The text is encrypted like every other reply — the relay never
  // sees plaintext. Returns delivered:false (not an error) when the room is not
  // up yet (early boot / mid re-pair) so a cron job's stderr stays quiet.
  const doNotify = async (text: string): Promise<{ delivered: boolean; message: string }> => {
    const body = text.trim();
    if (!body) throw new Error('notify requires a non-empty message');
    if (!ctrl) {
      return { delivered: false, message: 'Control room is not ready yet — try again once the daemon has paired.' };
    }
    await ctrl.reply(body);
    return { delivered: true, message: 'Posted to the control room.' };
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
    restart: () => doRestart(),
    notify: (text) => doNotify(text),
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
    ctrl = new ControlRoom(server, state, messageKey, manager, suggestedControlRoomName, scheduler);

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
            // Same first device retrying. The wrapped token is a live-only lobby
            // event, so the browser may miss it if its lobby SSE was not open
            // when we first approved. Re-approving this identical device/pubkey
            // re-sends the pass without admitting a new device; a different
            // pubkey still goes through explicit operator confirmation.
            if (iterState.controlBoundPubkey && knockPubkey === iterState.controlBoundPubkey) {
              try {
                const binding = await beginApprove(knockPubkey, knockMsgId);
                const approveRes = await api.approveKnock(server, iterState.controlRoomHash, iterState.participantToken, binding.claimTagHash);
                const bundle = JSON.stringify({
                  token: approveRes.new_participant_token,
                  subscriber_jwt: approveRes.subscriber_jwt,
                });
                const wrapped = await binding.wrap(bundle);
                await api.sendWrappedToken(server, iterState.controlRoomHash, iterState.participantToken, knockMsgId, wrapped);
                console.log('Re-sent control-room join pass to the bound device (knock retry).');
              } catch (err) {
                console.error('Failed to re-approve control-room retry:', err);
              }
              return;
            }
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
            iterState.controlBoundPubkey = knockPubkey;
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
                // Never log a secret's value; the handler below still gets it.
                const shown = br.type === 'secret' ? '[secret redacted]' : JSON.stringify(br.value);
                console.log(`Control [block ${br.block_id}]: ${shown}`);
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
      }, {
        // The subscriber JWT expires after 7 days; a daemon that stays up
        // across that line gets 401'd by Mercure on its next reconnect. The
        // participant token is still valid, so re-mint in place — the phone
        // notices nothing.
        refreshJwt: async () => {
          try {
            const next = await api.refreshSubscriberJwt(server, iterState.controlRoomHash, iterState.participantToken);
            iterState.subscriberJwt = next;
            await saveDaemonState(iterState);
            console.log('Control room subscriber JWT refreshed.');
            return next;
          } catch (err) {
            console.error('Control room subscriber JWT refresh failed (re-pair may be needed):', err instanceof Error ? err.message : String(err));
            return null;
          }
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
  // Show every *installed* agent — built-ins + registry — in one stacked
  // list. Stacked (not inline) because >3 buttons inline wrap awkwardly on
  // narrow viewports, and the picker is short-lived so vertical real estate
  // is cheap. The previous Top-3 + "More…" two-step exists only as historical
  // optimization for the welcome message; tapping Spawn now goes straight
  // to the full list.
  //
  // Empty means nothing the daemon can spawn is on this host's PATH — render a
  // hint instead of an empty picker so the operator knows what to do, rather
  // than tapping a button that would ENOENT.
  if (agentNames.length === 0) {
    return buildBlock({
      type: 'prose',
      content:
        'No supported agents found on this host. Install **Claude Code** or the **Codex CLI** (or register your own with `hisohiso daemon register`), then tap Help → Start session again.',
    });
  }
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

// #243: one buttons block per schedule for tappable management. The prompt
// carries the name + when + state; the action values embed the id so the
// block_response round-trip needs no extra state (mirrors agentRowBlock).
const scheduleRowBlock = (s: Schedule): unknown => {
  const state = s.enabled ? 'on' : 'paused';
  const last = s.lastStatus ? ` · last ${s.lastStatus}` : '';
  return buildBlock({
    type: 'buttons',
    id: `sched-row:${s.id}`,
    prompt: `${s.name} · ${formatCronUtc(s.cron)} · ${s.agent} · ${state}${last}`,
    style: 'inline',
    multi: false,
    options: [
      s.enabled
        ? { label: 'Pause', value: `sched-pause:${s.id}` }
        : { label: 'Resume', value: `sched-resume:${s.id}` },
      { label: 'Run now', value: `sched-run:${s.id}` },
      { label: 'Delete', value: `sched-del:${s.id}` },
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

// --- scheduler control-room command helpers (#232) ---

const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Parse a days token into a normalized cron dow list (0-6, 0=Sun). Accepts
// digits ("1,3,5"), names ("mon,wed,fri"), or the shortcuts "weekdays"/"daily".
// Returns null on anything unrecognized so a bad `schedule add` is rejected, not
// silently mis-scheduled.
function parseDaysToken(tok: string): string | null {
  const out = new Set<number>();
  for (const part of tok.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (part === 'weekdays') { [1, 2, 3, 4, 5].forEach((x) => out.add(x)); continue; }
    if (part === 'daily' || part === 'everyday' || part === '*') { [0, 1, 2, 3, 4, 5, 6].forEach((x) => out.add(x)); continue; }
    if (/^[0-6]$/.test(part)) { out.add(Number(part)); continue; }
    if (part in DOW_NAMES) { out.add(DOW_NAMES[part]!); continue; }
    return null;
  }
  if (out.size === 0) return null;
  return [...out].sort((a, b) => a - b).join(',');
}

// Render a stored UTC cron as a readable line. The control-room text surface
// shows UTC; the (future) phone clock UI renders in the device's local time.
function formatCronUtc(cron: string): string {
  const spec = parseCron(cron);
  if (!spec) return cron;
  const days = [...spec.days].sort((a, b) => a - b).map((d) => DOW_LABEL[d]).join('/');
  return `${days} ${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')} UTC`;
}

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
    private readonly suggestedName: string | null,
    private readonly scheduler: Scheduler
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
    action?: { type: string; roomSecret: string; label: string; code?: string; roomName?: string; room_kind?: 'chat' | 'control' | 'agent'; controlRoomHash?: string }
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
    const agentNames = await availableAgentNames();
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
      await this.reply('No agents running.', [launcherBlock(await availableAgentNames())]);
      return;
    }
    const blocks = agents.map((a) => agentRowBlock(a.agentId, a.name));
    await this.reply(`Running agents (${agents.length})`, blocks);
  }

  async sendHelp(): Promise<void> {
    const agentNames = await availableAgentNames();
    await this.reply(
      'Tap to act — or type a command (claude / list / kill <id> / schedules / help).',
      [helpButtonsBlock(), launcherBlock(agentNames)]
    );
  }

  // #232: list the daemon's recurring schedules. Times shown in UTC (the phone
  // clock UI will localize later).
  // #243: post the schedule list as one tappable buttons block per schedule
  // (Pause/Resume · Run now · Delete), mirroring the running-agents list. Times
  // shown in UTC (the phone has no tz channel here).
  async sendSchedules(): Promise<void> {
    const all = this.scheduler.list();
    if (all.length === 0) {
      await this.reply(
        'No schedules yet. Tap the clock to add one, or type:\n`schedule add <days> <timeUTC> <agent> <prompt>`',
      );
      return;
    }
    await this.reply(
      `Schedules (${all.length}) — times in UTC:`,
      all.map((s) => scheduleRowBlock(s)),
    );
  }

  // #232: handle `schedule <subcommand> ...`. Text-driven for now; the phone
  // clock UI (next slice) will drive the same Scheduler API via blocks/buttons.
  async handleScheduleCommand(rest: string): Promise<void> {
    const tokens = rest.split(/\s+/).filter(Boolean);
    const subcmd = (tokens[0] ?? '').toLowerCase();

    if (subcmd === 'add') {
      const days = parseDaysToken(tokens[1] ?? '');
      // Time token is UTC "H" or "H:MM" — the phone clock UI sends :MM for
      // half-hour offset zones (India +5:30, Nepal +5:45) so they round-trip.
      const timeTok = (tokens[2] ?? '').match(/^(\d{1,2})(?::(\d{1,2}))?$/);
      const hour = timeTok ? Number(timeTok[1]) : NaN;
      const minute = timeTok && timeTok[2] !== undefined ? Number(timeTok[2]) : 0;
      const agent = tokens[3];
      const prompt = tokens.slice(4).join(' ').trim();
      if (!days || !Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59 || !agent || !prompt) {
        await this.reply(
          'Usage: `schedule add <days> <timeUTC> <agent> <prompt>`\n' +
            'Days: mon,wed,fri | weekdays | daily | 0-6 (0=Sun). Time: 0-23 UTC, or H:MM (e.g. 20:30).\n' +
            'e.g. `schedule add weekdays 7 claude summarize overnight GitHub notifications`',
        );
        return;
      }
      const cron = `${minute} ${hour} * * ${days}`;
      const s = this.scheduler.add({ cron, agent, prompt });
      if (!s) {
        await this.reply('Could not create that schedule (invalid cron).');
        return;
      }
      const next = s.nextRunAt ? new Date(s.nextRunAt).toISOString() : 'never';
      await this.reply(`Scheduled ✓ ${s.name} [${s.id}]\n${formatCronUtc(cron)} · ${agent}\nNext run (UTC): ${next}`);
      return;
    }

    const id = tokens[1];
    if (!id) {
      await this.reply('Which schedule? `schedule <pause|resume|run|rm> <id>` — see `schedules`.');
      return;
    }
    if (subcmd === 'pause') {
      await this.reply(this.scheduler.pause(id) ? `Paused ${id}.` : `No active schedule ${id}.`);
      return;
    }
    if (subcmd === 'resume') {
      await this.reply(this.scheduler.resume(id) ? `Resumed ${id}.` : `No paused schedule ${id}.`);
      return;
    }
    if (subcmd === 'rm' || subcmd === 'remove' || subcmd === 'delete') {
      await this.reply(this.scheduler.remove(id) ? `Deleted ${id}.` : `No schedule ${id}.`);
      return;
    }
    if (subcmd === 'run') {
      const sched = this.scheduler.get(id);
      if (!sched) {
        await this.reply(`No schedule ${id}.`);
        return;
      }
      await this.reply(`Running ${sched.name} now…`);
      await this.scheduler.runNow(id);
      return;
    }
    await this.reply('Unknown schedule command. Try `schedule add|list|pause|resume|run|rm`.');
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
        [launcherBlock(await availableAgentNames())]
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
        // Authoritative parent link: the phone groups this agent under this
        // control room no matter where the operator taps Join from.
        controlRoomHash: this.state.controlRoomHash,
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
            await this.reply('Pick an agent.', [launcherBlock(await availableAgentNames())]);
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
          // #243: scheduler row-button taps. Pause/Resume/Delete re-post the list
          // so the UI refreshes; Run fires immediately.
          if (value === 'show-schedules') {
            await this.sendSchedules();
            return;
          }
          if (value.startsWith('sched-pause:')) {
            const id = value.slice('sched-pause:'.length);
            await this.reply(this.scheduler.pause(id) ? `Paused ${id}.` : `No active schedule ${id}.`);
            await this.sendSchedules();
            return;
          }
          if (value.startsWith('sched-resume:')) {
            const id = value.slice('sched-resume:'.length);
            await this.reply(this.scheduler.resume(id) ? `Resumed ${id}.` : `No paused schedule ${id}.`);
            await this.sendSchedules();
            return;
          }
          if (value.startsWith('sched-del:')) {
            const id = value.slice('sched-del:'.length);
            await this.reply(this.scheduler.remove(id) ? `Deleted ${id}.` : `No schedule ${id}.`);
            await this.sendSchedules();
            return;
          }
          if (value.startsWith('sched-run:')) {
            const id = value.slice('sched-run:'.length);
            const s = this.scheduler.get(id);
            if (!s) {
              await this.reply(`No schedule ${id}.`);
              return;
            }
            await this.reply(`Running ${s.name} now…`);
            await this.scheduler.runNow(id);
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
      // #232 scheduler commands. Match on the lower-cased text, but pass the
      // ORIGINAL-case remainder to the handler so the prompt keeps its casing.
      if (lower === 'schedules' || lower === 'schedule' || lower === 'schedule list') {
        await this.sendSchedules();
        return;
      }
      if (lower.startsWith('schedule ')) {
        await this.handleScheduleCommand(text.slice('schedule '.length).trim());
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
    // The stored subscriber JWT has a 7-day server TTL; the participant token
    // does not expire. A daemon restarting past (or near) that TTL would
    // subscribe with a dead JWT — Mercure 401s it and the control room goes
    // deaf while presence keeps the daemon looking online. Re-mint through
    // /sub-token instead; if even that fails the room is unrecoverable and we
    // fall through to a fresh pair.
    if (jwtExpiresWithin(saved.subscriberJwt, SUBSCRIBER_JWT_REFRESH_MARGIN_MS)) {
      console.log('Control room subscriber JWT expired/expiring — refreshing.');
      saved.subscriberJwt = await api.refreshSubscriberJwt(server, saved.controlRoomHash, saved.participantToken);
      await saveDaemonState(saved);
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
  // Agentic/browser test harnesses are also non-TTY: they can provide the
  // session knock via HISOHISO_KNOCK_MESSAGE and then ask the daemon's local
  // control socket for pair material. Treat those like service startup for
  // pairing: create an unbound room and let the daemon runtime approve the
  // first authenticated knock, instead of blocking forever in the pre-runtime
  // QR wait. Interactive foreground behavior is unchanged.
  const underService = Boolean(process.env.HISOHISO_SERVICE);
  const headlessPairing = underService || !process.stdin.isTTY;

  let sessionKnockMessage: string;
  const carriedEnvKnock = process.env.HISOHISO_CARRY_KNOCK;
  if (typeof carriedKnockMessage === 'string' && carriedKnockMessage !== '') {
    sessionKnockMessage = carriedKnockMessage;
  } else if (typeof carriedEnvKnock === 'string' && carriedEnvKnock !== '') {
    // Re-exec after `repair`/`server` (#134 pt2) carries the operator's session
    // knock here so the headless re-pair doesn't prompt. Consume it once.
    sessionKnockMessage = carriedEnvKnock;
    delete process.env.HISOHISO_CARRY_KNOCK;
  } else if (typeof process.env.HISOHISO_KNOCK_MESSAGE === 'string') {
    // Non-interactive pairing: a headless harness sources the session knock
    // message from the env, bypassing the hidden TTY prompt. An explicitly-set
    // empty value is rejected exactly as the prompt path rejects an empty line
    // — it does NOT fall through. Ordered AFTER the carry-knock signals (a
    // re-exec/re-pair takes priority) and BEFORE the underService refusal so a
    // service can pair with no prior foreground run. Consume it once so it can't
    // leak into spawned children's env.
    sessionKnockMessage = process.env.HISOHISO_KNOCK_MESSAGE;
    delete process.env.HISOHISO_KNOCK_MESSAGE;
    if (sessionKnockMessage === '') {
      console.error('Knock message cannot be empty. Aborting.');
      process.exit(1);
    }
  } else if (headlessPairing) {
    // No carried/env knock and no usable TTY — can't pair headlessly. Fail loudly
    // rather than hanging on an invisible prompt. Services normally get here only
    // if install/provisioning skipped the foreground pair; tests should set
    // HISOHISO_KNOCK_MESSAGE.
    console.error('Cannot pair headlessly with no carried knock — set HISOHISO_KNOCK_MESSAGE or pair once in the foreground first.');
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

  // Headless (service or non-TTY test harness): don't block on the first knock
  // against a QR no one can scan/read — that's the motivating bug. Persist an
  // UNBOUND control room and return; runDaemon's own onKnock handler binds the
  // first authenticated device, and `hisohiso pair` / the local control socket
  // renders or returns this pair material on demand. `hisohiso status` reports
  // "awaiting pairing" until a device binds.
  if (headlessPairing) {
    tempPresence.stop();
    const awaitingState: DaemonState = {
      controlRoomSecret,
      controlRoomHash,
      participantToken,
      subscriberJwt,
      controlRoomPassword: password,
      sessionKnockMessage,
      controlBound: false,
      controlBoundPubkey: undefined,
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

  let pairedControlBoundPubkey: string | undefined;
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
            pairedControlBoundPubkey = knockPubkey;
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
    controlBoundPubkey: pairedControlBoundPubkey,
    kdfVersion: 1,
  };
  await saveDaemonState(state);

  return { state, messageKey };
};
