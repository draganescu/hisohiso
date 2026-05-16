import { createRoomAndJoin, encryptAndSend, type SendOptions } from '../lib/room-bridge.js';
import { deriveMessageKey, sha256Hex, decryptText, type EncryptedPayload } from '../lib/crypto.js';
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
  participantToken: string;
  messageKey: CryptoKey;
  sessionId: string | null;
  running: boolean;
  sse: SSESubscription;
  presence: PresenceHandle;
};

type AttachArgs = {
  agentId: string;
  name: string;
  profile: AgentProfile;
  roomHash: string;
  roomSecret: string;
  participantToken: string;
  messageKey: CryptoKey;
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
  private controlRoomHash: string;
  private controlToken: string;
  private controlKey: CryptoKey | null = null;
  private controlRoomSecret: string;
  private controlPassword: string;

  constructor(
    server: string,
    controlRoomHash: string,
    controlToken: string,
    controlRoomSecret: string,
    controlPassword: string
  ) {
    this.server = server;
    this.controlRoomHash = controlRoomHash;
    this.controlToken = controlToken;
    this.controlRoomSecret = controlRoomSecret;
    this.controlPassword = controlPassword;
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

  async spawn(agentName: string): Promise<{ agentId: string; roomSecret: string }> {
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

    // Create room for this agent — catch-up on by default so the phone can
    // open the room later and see anything the agent emitted while it was closed.
    const room = await createRoomAndJoin(this.server, '', { catchUp: true });
    const agentId = room.roomHash.slice(0, 12);

    await this.attachToRoom({
      agentId,
      name: agentName,
      profile,
      roomHash: room.roomHash,
      roomSecret: room.roomSecret,
      participantToken: room.participantToken,
      messageKey: room.messageKey,
      sessionId: null,
    });

    await this.persistRooms();
    return { agentId, roomSecret: room.roomSecret };
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

        const profile = getAgent(r.name);
        if (!profile) {
          dropped.push(r.agentId);
          details.push(`${r.name} (${r.agentId}): unknown agent profile`);
          continue;
        }

        const messageKey = await deriveMessageKey(r.roomSecret, '');

        await this.attachToRoom({
          agentId: r.agentId,
          name: r.name,
          profile,
          roomHash: r.roomHash,
          roomSecret: r.roomSecret,
          participantToken: r.participantToken,
          messageKey,
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
    const { agentId, name: agentName, profile, roomHash, roomSecret, participantToken, messageKey, sessionId } = args;

    const presence = startPresence(this.server, roomHash, participantToken);
    const ownTokenHash = await sha256Hex(participantToken);

    const session: AgentSession = {
      agentId,
      name: agentName,
      profile,
      roomHash,
      roomSecret,
      participantToken,
      messageKey,
      sessionId,
      running: false,
      sse: null!,
      presence,
    };

    let resolveSseReady: () => void;
    const sseReady = new Promise<void>((resolve) => { resolveSseReady = resolve; });

    const sse = subscribeToRoom(this.server, roomHash, {
      onKnock: async () => {
        // Auto-approve phone joining agent room
        try {
          await api.approveKnock(this.server, roomHash, participantToken);
          console.log(`[${agentName}:${agentId}] Phone joined agent room.`);
        } catch (err) {
          console.error(`[${agentName}:${agentId}] Failed to approve knock:`, err);
        }
      },
      onDestroy: () => {
        console.log(`[${agentName}:${agentId}] Room destroyed. Cleaning up.`);
        session.sse.close();
        session.presence.stop();
        this.sessions.delete(agentId);
        void this.persistRooms();
        void this.sendControlMessage(`${agentName} (${agentId}) session ended — room was closed.`);
      },
      onChat: async (event: RoomEvent) => {
        if (event.from === ownTokenHash) return;

        // Decrypt inbound message
        let text: string;
        try {
          const encPayload = typeof event.body.encrypted_payload === 'string'
            ? JSON.parse(event.body.encrypted_payload) as EncryptedPayload
            : event.body.encrypted_payload as EncryptedPayload;
          const msgId = (event.body.msg_id as string) || '';
          const decrypted = await decryptText(messageKey, roomHash, 'chat', msgId, encPayload);
          const parsed = JSON.parse(decrypted) as { text: string };
          text = parsed.text;
        } catch (err) {
          console.error(`[${agentName}:${agentId}] Failed to decrypt:`, err);
          return;
        }

        console.log(`[${agentName}:${agentId}] <- ${text}`);

        if (session.running) {
          await encryptAndSend(
            this.server, roomHash, participantToken, messageKey,
            'Still running previous command. Please wait.'
          );
          return;
        }

        session.running = true;

        try {
          // Per-turn arg construction. buildResumeArgs fully overrides base args for resume turns
          // (codex's `exec resume <id>` is a subcommand, not a flag append). Default resume
          // strategy (claude) pushes `--resume <id>` onto the base args.
          const isResume = session.profile.mode === 'session' && session.sessionId !== null;
          const argv = isResume && session.profile.buildResumeArgs
            ? session.profile.buildResumeArgs(session.sessionId!)
            : [...session.profile.args];

          let messageToSend = text;
          if (session.profile.appendSystemPrompt) {
            if (session.profile.systemPromptMode === 'prepend-message-once') {
              if (!isResume) messageToSend = `${session.profile.appendSystemPrompt}\n\n${text}`;
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

          const result = await runCommand(session.profile.command, argv);

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

        session.running = false;
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

  async kill(agentId: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) {
      throw new Error(`No agent with ID "${agentId}"`);
    }
    session.sse.close();
    session.presence.stop();
    this.sessions.delete(agentId);
    await this.persistRooms();
  }

  listRunning(): Array<{ agentId: string; name: string }> {
    return Array.from(this.sessions.values()).map((s) => ({
      agentId: s.agentId,
      name: s.name,
    }));
  }

  async killAll(): Promise<void> {
    for (const [, session] of this.sessions) {
      session.sse.close();
      session.presence.stop();
    }
    this.sessions.clear();
    await this.persistRooms();
  }

  private async persistRooms(): Promise<void> {
    const rooms: ActiveRoom[] = Array.from(this.sessions.values()).map((s) => ({
      agentId: s.agentId,
      name: s.name,
      roomHash: s.roomHash,
      roomSecret: s.roomSecret,
      participantToken: s.participantToken,
      sessionId: s.sessionId,
      pid: 0,
    }));
    await saveActiveRooms(rooms);
  }
}
