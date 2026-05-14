import { createRoomAndJoin, encryptAndSend, type SendOptions } from '../lib/room-bridge.js';
import { deriveMessageKey, sha256Hex, decryptText, type EncryptedPayload } from '../lib/crypto.js';
import { runCommand, parseJsonOutput, parseBlockOutput } from '../lib/agent-process.js';
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

    // Create room for this agent
    const room = await createRoomAndJoin(this.server, '');
    const agentId = room.roomHash.slice(0, 12);

    // Start presence
    const presence = startPresence(this.server, room.roomHash, room.participantToken);

    // Set up per-message handler for this agent room
    const ownTokenHash = await sha256Hex(room.participantToken);

    const session: AgentSession = {
      agentId,
      name: agentName,
      profile,
      roomHash: room.roomHash,
      roomSecret: room.roomSecret,
      participantToken: room.participantToken,
      messageKey: room.messageKey,
      sessionId: null,
      running: false,
      sse: null!,
      presence,
    };

    let resolveSseReady: () => void;
    const sseReady = new Promise<void>((resolve) => { resolveSseReady = resolve; });

    const sse = subscribeToRoom(this.server, room.roomHash, {
      onKnock: async () => {
        // Auto-approve phone joining agent room
        try {
          await api.approveKnock(this.server, room.roomHash, room.participantToken);
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
          const decrypted = await decryptText(room.messageKey, room.roomHash, 'chat', msgId, encPayload);
          const parsed = JSON.parse(decrypted) as { text: string };
          text = parsed.text;
        } catch (err) {
          console.error(`[${agentName}:${agentId}] Failed to decrypt:`, err);
          return;
        }

        console.log(`[${agentName}:${agentId}] <- ${text}`);

        if (session.running) {
          await encryptAndSend(
            this.server, room.roomHash, room.participantToken, room.messageKey,
            'Still running previous command. Please wait.'
          );
          return;
        }

        session.running = true;

        try {
          // Build args — session mode adds --resume
          const args = [...session.profile.args];
          if (session.profile.appendSystemPrompt) {
            args.push('--append-system-prompt', session.profile.appendSystemPrompt);
          }
          if (session.profile.mode === 'session' && session.sessionId) {
            args.push('--resume', session.sessionId);
          }
          args.push(text);

          const displayArgs = args.map(a => a.length > 80 ? `"${a.slice(0, 40)}..."` : a.includes(' ') ? `"${a}"` : a);
          console.log(`[${agentName}:${agentId}]   $ ${session.profile.command} ${displayArgs.join(' ')}`);

          const result = await runCommand(session.profile.command, args);

          let output: string;
          if (session.profile.mode === 'session') {
            const parsed = parseJsonOutput(result.stdout);
            if (parsed.sessionId) {
              session.sessionId = parsed.sessionId;
            }
            output = (parsed.text || result.stderr || '(no output)').trim();
          } else {
            output = (result.stdout || result.stderr || '(no output)').trim();
          }

          // Try to parse block-structured output
          const blockParsed = parseBlockOutput(output);
          const sendText = blockParsed?.text ?? output;
          const sendBlocks = blockParsed?.blocks ?? undefined;

          console.log(`[${agentName}:${agentId}] -> ${sendText.slice(0, 120)}${sendText.length > 120 ? '...' : ''}${sendBlocks ? ` [${sendBlocks.length} blocks]` : ''}`);

          // Send output back — split if too long
          const MAX_MSG = 4000;
          if (sendText.length <= MAX_MSG) {
            await encryptAndSend(this.server, room.roomHash, room.participantToken, room.messageKey, sendText, { blocks: sendBlocks });
          } else {
            for (let i = 0; i < sendText.length; i += MAX_MSG) {
              const chunk = sendText.slice(i, i + MAX_MSG);
              await encryptAndSend(this.server, room.roomHash, room.participantToken, room.messageKey, chunk, i === 0 ? { blocks: sendBlocks } : undefined);
            }
          }

          if (result.code !== 0 && result.stderr) {
            await encryptAndSend(
              this.server, room.roomHash, room.participantToken, room.messageKey,
              `(exit code ${result.code})`
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[${agentName}:${agentId}] Error:`, msg);
          await encryptAndSend(
            this.server, room.roomHash, room.participantToken, room.messageKey,
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

    // Wait for SSE to connect before returning — ensures knock listener
    // is active before the join button is sent to the phone
    await sseReady;
    await this.persistRooms();

    return { agentId, roomSecret: room.roomSecret };
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
      pid: 0,
    }));
    await saveActiveRooms(rooms);
  }
}
