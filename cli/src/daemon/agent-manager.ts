import { createRoomAndJoin, encryptAndSend, type SendOptions } from '../lib/room-bridge.js';
import { deriveMessageKey, deriveKnockKey, sha256Hex, decryptText, beginApprove, type EncryptedPayload } from '../lib/crypto.js';
import { generatePairingCode } from '../lib/prompt.js';
import { runCommand, parseJsonOutput, parseCodexNdjson, parseBlockOutput } from '../lib/agent-process.js';
import { getAgent, type AgentProfile } from '../lib/agents.js';
import { loadRegistry, saveActiveRooms, type ActiveRoom } from '../lib/config.js';
import { subscribeToRoom, type RoomEvent, type SSESubscription } from '../lib/sse-client.js';
import { startPresence, type PresenceHandle } from '../lib/presence.js';
import * as api from '../lib/api-client.js';

type AgentSession = {
  agentId: string;
  name: string;
  profile: AgentProfile;
  roomHash: string;
  roomSecret: string;
  roomPassword: string;
  participantToken: string;
  subscriberJwt: string;
  messageKey: CryptoKey;
  knockKey: CryptoKey;
  sessionId: string | null;
  running: boolean;
  // Messages that arrived while `running` was true. Instead of bouncing them
  // with "still running", we buffer here and the in-flight turn drains the
  // whole batch into ONE coalesced follow-up turn when it finishes. `from`
  // is retained so the untrusted-content envelope can still be labelled.
  pending: Array<{ text: string; from: string }>;
  sse: SSESubscription;
  presence: PresenceHandle;
  // Per-session msg_id dedup — drops any chat we've already dispatched to the
  // agent. The server can re-publish identical ciphertexts (it has the
  // publisher JWT, AAD is deterministic for the same msg_id); without this
  // the agent would re-execute a captured turn. In-memory only — replay
  // window is the session lifetime, which is what we care about.
  seenMsgIds: Set<string>;
  // Wall-clock ms of the most recently delivered SSE event on this session.
  // Bumped by onAnyEvent in sse-client. Initialized at attach time. Stale
  // values mean either the room is genuinely idle OR the SSE silently died —
  // we can't tell those apart without server-side heartbeats, so this is a
  // diagnostic breadcrumb, not a kill switch. Reconcile is the authoritative
  // liveness check; this timestamp just tells you which session to suspect.
  lastEventAt: number;
};

type AttachArgs = {
  agentId: string;
  name: string;
  profile: AgentProfile;
  roomHash: string;
  roomSecret: string;
  // 4-digit pairing code that derived this room's k_msg/k_knock. Persisted on
  // ActiveRoom so a daemon restart can re-derive identical keys.
  roomPassword: string;
  participantToken: string;
  subscriberJwt: string;
  messageKey: CryptoKey;
  knockKey: CryptoKey;
  sessionId: string | null;
};

export type RestoreResult = {
  restored: number;
  dropped: number;
  details: string[];
};

export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private server: string;

  // Used by the auto-updater to decide when it's safe to swap the binary and
  // re-exec — every session that's mid-turn has `running = true`, so idle =
  // every session is between turns (or there are no sessions).
  isIdle(): boolean {
    for (const session of this.sessions.values()) {
      if (session.running) return false;
    }
    return true;
  }

  private controlRoomHash: string;
  private controlToken: string;
  private controlKey: CryptoKey | null = null;
  private controlRoomSecret: string;
  private controlPassword: string;
  // The operator's session-wide knock message. Compared against the decrypted
  // cleartext of every incoming /knock; mismatched knocks are dropped without
  // approving. Held by-value (not via DaemonState ref) so a re-pair that
  // mutates control room identity doesn't accidentally reset the secret.
  private sessionKnockMessage: string;

  constructor(
    server: string,
    controlRoomHash: string,
    controlToken: string,
    controlRoomSecret: string,
    controlPassword: string,
    sessionKnockMessage: string
  ) {
    this.server = server;
    this.controlRoomHash = controlRoomHash;
    this.controlToken = controlToken;
    this.controlRoomSecret = controlRoomSecret;
    this.controlPassword = controlPassword;
    this.sessionKnockMessage = sessionKnockMessage;
  }

  private async getControlKey(): Promise<CryptoKey> {
    if (!this.controlKey) {
      this.controlKey = await deriveMessageKey(this.controlRoomSecret, this.controlPassword);
    }
    return this.controlKey;
  }

  private async sendControlMessage(text: string, options?: SendOptions): Promise<void> {
    const key = await this.getControlKey();
    await encryptAndSend(this.server, this.controlRoomHash, this.controlToken, key, text, {
      handle: 'hisohiso-daemon',
      ...options,
    });
  }

  async spawn(agentName: string): Promise<{ agentId: string; roomSecret: string; roomPassword: string }> {
    // Resolve profile: check built-in agents first, then registry
    let profile = getAgent(agentName);
    if (!profile) {
      const registry = await loadRegistry();
      const entry = registry.find((a) => a.name === agentName);
      if (entry) {
        profile = { command: entry.command, args: [], description: entry.name, mode: 'oneshot' };
      }
    }
    if (!profile) {
      throw new Error(`Unknown agent "${agentName}". Use "list" to see available agents.`);
    }

    // Mint a fresh 4-digit pairing code for this agent room. It's the password
    // factor folded into k_msg/k_knock — the phone needs it to even produce a
    // decryptable knock, and we broadcast it via the control-room chat below
    // so the operator can read it off the phone they're already holding.
    const roomPassword = generatePairingCode();
    const room = await createRoomAndJoin(this.server, roomPassword, { catchUp: true });
    const agentId = room.roomHash.slice(0, 12);
    const knockKey = await deriveKnockKey(room.roomSecret, roomPassword);

    await this.attachToRoom({
      agentId,
      name: agentName,
      profile,
      roomHash: room.roomHash,
      roomSecret: room.roomSecret,
      roomPassword,
      participantToken: room.participantToken,
      subscriberJwt: room.subscriberJwt,
      messageKey: room.messageKey,
      knockKey,
      sessionId: null,
    });

    await this.persistRooms();
    return { agentId, roomSecret: room.roomSecret, roomPassword };
  }

  /**
   * Restore previously-active rooms after a daemon restart. For each persisted room:
   *  - Verify it still exists server-side (via checkRoom). If not, drop it.
   *  - Resolve its profile from the built-in agents map. If unknown, drop it.
   *  - Derive the message key from the room secret, re-attach SSE + presence, and
   *    register the session in memory with its persisted sessionId so the next
   *    phone message can continue via --resume / exec resume.
   *
   * The agent process itself is NOT respawned — there is no long-running agent process
   * between turns. Conversation continuity is provided by the LLM provider's session
   * files (~/.claude/projects/..., ~/.codex/sessions/...) which already survive restart.
   */
  async restore(rooms: ActiveRoom[]): Promise<RestoreResult> {
    const restored: string[] = [];
    const dropped: string[] = [];
    const details: string[] = [];

    // Load registry once so wrap-registered agents (e.g. hermes) resolve here,
    // not just in spawn(). Without this, any non-builtin room on disk gets
    // dropped as "unknown agent profile" after a daemon restart.
    const registry = await loadRegistry();

    for (const r of rooms) {
      try {
        let serverOk = false;
        try {
          await api.checkRoom(this.server, r.roomHash);
          serverOk = true;
        } catch {
          serverOk = false;
        }

        if (!serverOk) {
          dropped.push(r.agentId);
          details.push(`${r.name} (${r.agentId}): room no longer exists server-side`);
          continue;
        }

        let profile = getAgent(r.name);
        if (!profile) {
          const entry = registry.find((a) => a.name === r.name);
          if (entry) {
            profile = { command: entry.command, args: [], description: entry.name, mode: 'oneshot' };
          }
        }
        if (!profile) {
          dropped.push(r.agentId);
          details.push(`${r.name} (${r.agentId}): unknown agent profile`);
          continue;
        }

        if (!r.subscriberJwt) {
          // Daemon was upgraded across the Mercure-auth boundary; the old room
          // entry has no subscriber JWT and we can't get one back without
          // re-pairing. Drop rather than serve a half-broken session.
          dropped.push(r.agentId);
          details.push(`${r.name} (${r.agentId}): missing subscriber JWT (pre-v0.4.2 room); re-spawn after upgrade`);
          continue;
        }

        // Pre-v0.4.5 rooms on disk have no roomPassword. Drop rather than try
        // to derive incompatible keys — the operator can respawn via control.
        if (typeof r.roomPassword !== 'string' || r.roomPassword === '') {
          dropped.push(r.agentId);
          details.push(`${r.name} (${r.agentId}): missing roomPassword (pre-pairing-code room); respawn`);
          continue;
        }
        const messageKey = await deriveMessageKey(r.roomSecret, r.roomPassword);
        const knockKey = await deriveKnockKey(r.roomSecret, r.roomPassword);

        await this.attachToRoom({
          agentId: r.agentId,
          name: r.name,
          profile,
          roomHash: r.roomHash,
          roomSecret: r.roomSecret,
          roomPassword: r.roomPassword,
          participantToken: r.participantToken,
          subscriberJwt: r.subscriberJwt,
          messageKey,
          knockKey,
          sessionId: r.sessionId,
        });

        restored.push(r.agentId);
        console.log(`[${r.name}:${r.agentId}] Restored from previous daemon run.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dropped.push(r.agentId);
        details.push(`${r.name} (${r.agentId}): ${msg}`);
      }
    }

    // Rewrite the rooms file so the dropped entries are removed and any
    // restored ones reflect their current in-memory state.
    await this.persistRooms();

    return { restored: restored.length, dropped: dropped.length, details };
  }

  /**
   * Wire up an agent session against an already-known room — used by both spawn()
   * (after createRoomAndJoin) and restore() (after loading from disk). Subscribes to
   * SSE, starts presence, installs the chat handler, and registers the session in
   * the in-memory map. Resolves once SSE is connected so the caller can safely
   * announce that the room is live.
   */
  private async attachToRoom(args: AttachArgs): Promise<void> {
    const { agentId, name: agentName, profile, roomHash, roomSecret, roomPassword, participantToken, subscriberJwt, messageKey, knockKey, sessionId } = args;

    const presence = startPresence(this.server, roomHash, participantToken);
    const ownTokenHash = await sha256Hex(participantToken);

    const session: AgentSession = {
      agentId,
      name: agentName,
      profile,
      roomHash,
      roomSecret,
      roomPassword,
      participantToken,
      subscriberJwt,
      messageKey,
      knockKey,
      sessionId,
      running: false,
      pending: [],
      sse: null!,
      presence,
      seenMsgIds: new Set<string>(),
      lastEventAt: Date.now(),
    };

    // Execute one agent turn for `text`. The onChat handler owns the turn
    // lifecycle (the `running` flag and queue draining); this is just a single
    // spawn→parse→send cycle. `peerHandle` labels the untrusted-content envelope.
    const runTurn = async (text: string, peerHandle: string): Promise<void> => {
      try {
        // Per-turn arg construction. buildResumeArgs fully overrides base args for resume turns
        // (codex's `exec resume <id>` is a subcommand, not a flag append). Default resume
        // strategy (claude) pushes `--resume <id>` onto the base args.
        const isResume = session.profile.mode === 'session' && session.sessionId !== null;
        const argv = isResume && session.profile.buildResumeArgs
          ? session.profile.buildResumeArgs(session.sessionId!)
          : [...session.profile.args];

        // Wrap inbound chat in an explicit untrusted-content envelope. The room model is
        // flat — we can't reliably tell the operator apart from other peers by token hash
        // alone, so we label everything as peer-authored. The agent's system prompt
        // instructs it to treat the envelope body as data, not instructions, which is the
        // defense against "respond with this exact JSON link-preview block" injection.
        const wrappedText = `<untrusted-peer-message from="${peerHandle.replace(/"/g, '')}">\n${text}\n</untrusted-peer-message>`;

        let messageToSend = wrappedText;
        if (session.profile.appendSystemPrompt) {
          if (session.profile.systemPromptMode === 'codex-config') {
            // Codex: inject via --config instructions=<value> on every turn (initial + resume).
            // Unlike 'prepend-message-once', this survives resume turns because it's a CLI flag
            // processed fresh each invocation, and it doesn't pollute the user message.
            argv.push('--config', `instructions=${session.profile.appendSystemPrompt}`);
          } else if (session.profile.systemPromptMode === 'prepend-message-once') {
            if (!isResume) messageToSend = `${session.profile.appendSystemPrompt}\n\n${wrappedText}`;
          } else {
            argv.push('--append-system-prompt', session.profile.appendSystemPrompt);
          }
        }

        if (isResume && !session.profile.buildResumeArgs) {
          argv.push('--resume', session.sessionId!);
        }
        argv.push(messageToSend);

        const displayArgs = argv.map(a => a.length > 80 ? `"${a.slice(0, 40)}..."` : a.includes(' ') ? `"${a}"` : a);
        console.log(`[${agentName}:${agentId}]   $ ${session.profile.command} ${displayArgs.join(' ')}`);

        const result = await runCommand(session.profile.command, argv, {
          env: {
            HISOHISO_AGENT_ID: session.agentId,
            HISOHISO_AGENT_NAME: session.name,
            HISOHISO_ROOM_HASH: session.roomHash,
            HISOHISO_ROOM_SECRET: session.roomSecret,
          },
        });

        // Parser dispatch is driven by profile.outputFormat regardless of mode — oneshot
        // profiles can still emit structured output (e.g. codex-once uses `--json`). sessionId
        // capture is gated on session mode since oneshot turns don't persist one.
        let parsedText: string;
        let parsedSessionId: string | null = null;

        if (session.profile.outputFormat === 'codex-ndjson') {
          const parsed = parseCodexNdjson(result.stdout);
          parsedText = parsed.text;
          parsedSessionId = parsed.sessionId;
        } else if (session.profile.mode === 'session') {
          const parsed = parseJsonOutput(result.stdout);
          parsedText = parsed.text;
          parsedSessionId = parsed.sessionId;
        } else {
          parsedText = result.stdout;
        }

        const output = (parsedText || result.stderr || '(no output)').trim();

        if (session.profile.mode === 'session' && parsedSessionId && parsedSessionId !== session.sessionId) {
          session.sessionId = parsedSessionId;
          // Persist immediately so a daemon restart can pick up exactly where we are.
          // Cheap (small JSON write); session-mode agents rotate sessionId per turn so this
          // keeps the on-disk handle current.
          void this.persistRooms();
        }

        // Try to parse block-structured output
        const blockParsed = parseBlockOutput(output);
        const sendText = blockParsed?.text ?? output;
        const sendBlocks = blockParsed?.blocks ?? undefined;

        console.log(`[${agentName}:${agentId}] -> ${sendText.slice(0, 120)}${sendText.length > 120 ? '...' : ''}${sendBlocks ? ` [${sendBlocks.length} blocks]` : ''}`);

        // Send output back — split if too long
        const MAX_MSG = 4000;
        if (sendText.length <= MAX_MSG) {
          await encryptAndSend(this.server, roomHash, participantToken, messageKey, sendText, { blocks: sendBlocks });
        } else {
          for (let i = 0; i < sendText.length; i += MAX_MSG) {
            const chunk = sendText.slice(i, i + MAX_MSG);
            await encryptAndSend(this.server, roomHash, participantToken, messageKey, chunk, i === 0 ? { blocks: sendBlocks } : undefined);
          }
        }

        if (result.code !== 0 && result.stderr) {
          await encryptAndSend(
            this.server, roomHash, participantToken, messageKey,
            `(exit code ${result.code})`
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${agentName}:${agentId}] Error:`, msg);
        await encryptAndSend(
          this.server, roomHash, participantToken, messageKey,
          `Error: ${msg}`
        ).catch(() => {});
      }
    };

    let resolveSseReady: () => void;
    const sseReady = new Promise<void>((resolve) => { resolveSseReady = resolve; });

    const sse = subscribeToRoom(this.server, roomHash, subscriberJwt, {
      onAnyEvent: (event: RoomEvent) => {
        session.lastEventAt = Date.now();
        void event;
      },
      onKnock: async (knockEvent: RoomEvent) => {
        // Gate the auto-approve on TWO checks:
        //   1. The encrypted_payload must decrypt with k_knock (which means the
        //      knocker had room_secret + the room's pairing code).
        //   2. The decrypted cleartext must EQUAL this daemon's sessionKnockMessage
        //      (the operator's session secret, never on the wire as plaintext).
        // Either check failing → drop the knock silently. No 'please retry'
        // back to the room because we can't authenticate the knocker yet,
        // and any error path that does leak info helps a brute-forcer.
        const knockPubkey = knockEvent.body?.knock_pubkey;
        const knockMsgId = knockEvent.body?.msg_id;
        const rawPayload = knockEvent.body?.encrypted_payload;
        if (typeof knockPubkey !== 'string' || typeof knockMsgId !== 'string' || !rawPayload) {
          console.error(`[${agentName}:${agentId}] knock missing fields — ignoring`);
          return;
        }
        let knockText: string;
        try {
          const enc: EncryptedPayload = typeof rawPayload === 'string'
            ? JSON.parse(rawPayload) as EncryptedPayload
            : rawPayload as EncryptedPayload;
          knockText = (await decryptText(knockKey, roomHash, 'knock', knockMsgId, enc)).trim();
        } catch {
          console.error(`[${agentName}:${agentId}] knock decrypt failed — wrong pairing code, ignoring`);
          return;
        }
        if (knockText !== this.sessionKnockMessage) {
          console.error(`[${agentName}:${agentId}] knock message mismatch — ignoring`);
          return;
        }
        try {
          const binding = await beginApprove(knockPubkey, knockMsgId);
          const approveRes = await api.approveKnock(this.server, roomHash, participantToken, binding.claimTagHash);
          const bundle = JSON.stringify({
            token: approveRes.new_participant_token,
            subscriber_jwt: approveRes.subscriber_jwt,
          });
          const wrapped = await binding.wrap(bundle);
          await api.sendWrappedToken(this.server, roomHash, participantToken, knockMsgId, wrapped);
          console.log(`[${agentName}:${agentId}] Phone joined agent room.`);
        } catch (err) {
          console.error(`[${agentName}:${agentId}] Failed to approve knock:`, err);
        }
      },
      onDestroy: () => {
        console.log(`[${agentName}:${agentId}] Room destroyed. Cleaning up.`);
        this.closeSession(agentId, 'destroyed');
        void this.sendControlMessage(`${agentName} (${agentId}) session ended — room was closed.`);
      },
      onChat: async (event: RoomEvent) => {
        if (event.from === ownTokenHash) return;

        // Replay protection: drop any chat we've already dispatched to the
        // agent in this session. AAD includes msg_id but doesn't prevent the
        // SAME ciphertext arriving twice (server can re-publish; offline-sync
        // can re-deliver). Without this, the agent re-executes captured turns.
        const incomingMsgId = (event.body.msg_id as string) || '';
        if (incomingMsgId === '') {
          console.error(`[${agentName}:${agentId}] chat without msg_id — dropping`);
          return;
        }
        if (session.seenMsgIds.has(incomingMsgId)) {
          console.error(`[${agentName}:${agentId}] replay of msg_id ${incomingMsgId} — dropping`);
          return;
        }
        session.seenMsgIds.add(incomingMsgId);

        // Decrypt inbound message
        let text: string;
        try {
          const encPayload = typeof event.body.encrypted_payload === 'string'
            ? JSON.parse(event.body.encrypted_payload) as EncryptedPayload
            : event.body.encrypted_payload as EncryptedPayload;
          const msgId = incomingMsgId;
          const decrypted = await decryptText(messageKey, roomHash, 'chat', msgId, encPayload);
          const parsed = JSON.parse(decrypted) as { text: string };
          text = parsed.text;
        } catch (err) {
          console.error(`[${agentName}:${agentId}] Failed to decrypt:`, err);
          return;
        }

        console.log(`[${agentName}:${agentId}] <- ${text}`);

        // Mid-turn message: queue it instead of bouncing with "still running".
        // The in-flight turn drains the queue when it finishes, coalescing the
        // whole pending batch into ONE follow-up resume turn — so rapid-fire
        // steering messages land in order on the next turn.
        if (session.running) {
          session.pending.push({ text, from: event.from || 'unknown' });
          await encryptAndSend(
            this.server, roomHash, participantToken, messageKey,
            `📥 Queued — will run after the current turn (${session.pending.length} pending).`
          );
          return;
        }

        session.running = true;
        try {
          await runTurn(text, event.from || 'unknown');
          // Drain whatever queued while we ran. Coalesce the batch into a single
          // turn so several steering messages become one combined instruction;
          // the loop re-checks because more can arrive during this drain turn.
          while (session.pending.length > 0) {
            const batch = session.pending.splice(0, session.pending.length);
            const combined = batch.map(p => p.text).join('\n\n');
            await runTurn(combined, batch[0]!.from);
          }
        } finally {
          session.running = false;
        }
      },
      onOpen: () => {
        console.log(`[${agentName}:${agentId}] SSE connected.`);
        resolveSseReady();
      },
      onError: (err) => {
        console.error(`[${agentName}:${agentId}] SSE error:`, err);
      },
    });

    session.sse = sse;
    this.sessions.set(agentId, session);

    // Wait for SSE to connect before returning — ensures the room is fully wired
    // before the caller (spawn() join-button send / restore() success report) proceeds.
    await sseReady;
  }

  // Point the manager at a freshly-paired control room. Used by the re-pair loop in
  // runDaemon when the phone disbands the control room mid-run. Agent sessions are
  // untouched — only the channel we send control-room status messages on changes.
  updateControlRoom(hash: string, token: string, secret: string, password: string): void {
    this.controlRoomHash = hash;
    this.controlToken = token;
    this.controlRoomSecret = secret;
    this.controlPassword = password;
    this.controlKey = null;
  }

  async kill(agentId: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) {
      throw new Error(`No agent with ID "${agentId}"`);
    }
    this.closeSession(agentId, 'killed');
    await this.persistRooms();
  }

  // Shared local-cleanup primitive used by onDestroy (SSE delivered the
  // destroy event), kill (operator typed `kill <id>`), and reconcile
  // (authoritative server check said the room is gone). Does NOT call
  // disbandRoom — that's a separate decision the operator drives. Idempotent:
  // safe to call for an agentId that's already been removed.
  private closeSession(agentId: string, reason: 'destroyed' | 'killed' | 'reconciled-gone'): void {
    const session = this.sessions.get(agentId);
    if (!session) return;
    try { session.sse.close(); } catch { /* */ }
    try { session.presence.stop(); } catch { /* */ }
    this.sessions.delete(agentId);
    void this.persistRooms();
    console.log(`[${session.name}:${agentId}] Session closed (${reason}).`);
  }

  // Tri-state reconciliation against the server for a single session.
  // 'gone'    → server returned 404, runs closeSession and returns 'gone'
  // 'alive'   → server says room exists, no local change
  // 'unknown' → couldn't determine (network / 5xx), no local change
  // Designed for periodic backgrounding AND on-demand calls from sendList,
  // so any operator-visible `list` is always reading reconciled state.
  async reconcileSession(agentId: string): Promise<api.RoomStatus> {
    const session = this.sessions.get(agentId);
    if (!session) return 'gone';
    const status = await api.roomStatus(this.server, session.roomHash);
    if (status === 'gone') {
      // SSE missed the destroy event (silent death, race during reconnect,
      // missed publish — root cause doesn't matter, the server is the truth).
      this.closeSession(agentId, 'reconciled-gone');
      void this.sendControlMessage(`${session.name} (${agentId}) cleaned up — room was gone server-side.`);
    } else if (status === 'alive') {
      const quietForMs = Date.now() - session.lastEventAt;
      const STALE_AFTER_MS = 5 * 60 * 1000;
      if (quietForMs > STALE_AFTER_MS) {
        // Diagnostic only — could legitimately be an idle alive SSE OR a
        // silently broken one. Logged so log-grep can correlate complaints
        // ("agent went dark") with the actual quiescent window.
        console.warn(`[${session.name}:${agentId}] SSE quiet for ${Math.round(quietForMs / 1000)}s but room is alive — possible silent SSE death.`);
      }
    }
    return status;
  }

  // Reconcile every session in parallel. Used by sendList and by the
  // periodic background tick. Returns a summary so callers can log /
  // surface cleanup counts. Errors per session are swallowed inside
  // reconcileSession (they become 'unknown'), so this never throws.
  async reconcileAll(): Promise<{ cleaned: string[]; alive: number; unknown: number }> {
    const ids = Array.from(this.sessions.keys());
    const results = await Promise.all(ids.map(async (id) => ({ id, status: await this.reconcileSession(id) })));
    const cleaned = results.filter((r) => r.status === 'gone').map((r) => r.id);
    const alive = results.filter((r) => r.status === 'alive').length;
    const unknown = results.filter((r) => r.status === 'unknown').length;
    return { cleaned, alive, unknown };
  }

  listRunning(): Array<{ agentId: string; name: string }> {
    return Array.from(this.sessions.values()).map((s) => ({
      agentId: s.agentId,
      name: s.name,
    }));
  }

  getRoomInfo(agentId: string): { name: string; roomSecret: string; roomPassword: string } | null {
    const s = this.sessions.get(agentId);
    if (!s) return null;
    return { name: s.name, roomSecret: s.roomSecret, roomPassword: s.roomPassword };
  }

  // Close in-process resources without touching the persisted rooms file. Used on
  // daemon shutdown so the next start can restore via loadActiveRooms(). The on-disk
  // record is already current — every successful turn persists the rotated sessionId.
  detachAll(): void {
    for (const [, session] of this.sessions) {
      session.sse.close();
      session.presence.stop();
    }
    this.sessions.clear();
  }

  private async persistRooms(): Promise<void> {
    const rooms: ActiveRoom[] = Array.from(this.sessions.values()).map((s) => ({
      agentId: s.agentId,
      name: s.name,
      roomHash: s.roomHash,
      roomSecret: s.roomSecret,
      roomPassword: s.roomPassword,
      participantToken: s.participantToken,
      subscriberJwt: s.subscriberJwt,
      sessionId: s.sessionId,
      pid: 0,
    }));
    await saveActiveRooms(rooms);
  }
}
