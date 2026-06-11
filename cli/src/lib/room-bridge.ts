import {
  generateRoomSecret,
  deriveRoomHash,
  deriveMessageKey,
  encryptText,
  decryptText,
  randomBytes,
  base64UrlEncode,
  sha256Hex,
  type EncryptedPayload,
} from './crypto.js';
import * as api from './api-client.js';
import { subscribeToRoom, type RoomEvent, type SSESubscription } from './sse-client.js';
import { startPresence, type PresenceHandle } from './presence.js';
import { parseLine, type ParsedLine } from './convention-parser.js';
import { type AgentHandle } from './agent-process.js';
import { decodeControlMessage } from './control-protocol.js';

const FLUSH_INTERVAL_MS = 500;
const FLUSH_MAX_LINES = 50;

// Bound a quoted snippet to one readable stdin line: collapse whitespace and
// cap length so a long original message can't blow out the agent's input line.
export const quoteForAgent = (quote: string): string => {
  const compact = quote.replace(/\s+/g, ' ').trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
};

export const createRoomAndJoin = async (
  server: string,
  password = '',
  opts?: { catchUp?: boolean }
): Promise<{ roomSecret: string; roomHash: string; participantToken: string; subscriberJwt: string; messageKey: CryptoKey }> => {
  const roomSecret = generateRoomSecret();
  const roomHash = await deriveRoomHash(roomSecret);
  const result = await api.createRoom(server, roomHash, opts);
  if (!result.participant_token || !result.subscriber_jwt) {
    throw new Error('Failed to create room: no token or subscriber_jwt returned');
  }
  const messageKey = await deriveMessageKey(roomSecret, password);
  return {
    roomSecret,
    roomHash,
    participantToken: result.participant_token,
    subscriberJwt: result.subscriber_jwt,
    messageKey,
  };
};

export type RoomKind = 'chat' | 'control' | 'agent';

export type SendOptions = {
  handle?: string;
  // `code` carries the per-agent-room pairing code so the phone's join button
  // can display 'Pairing code: 4827' next to it. The phone must type it as the
  // room password during the join flow — that's what gates k_msg/k_knock.
  // `room_kind` on the action lets the phone stamp the joined room's kind.
  action?: { type: string; roomSecret: string; label: string; code?: string; roomName?: string; room_kind?: RoomKind };
  blocks?: unknown[];
  // Room-kind discriminator carried inside the encrypted envelope. The phone
  // reads it to learn what a QR-paired room is (e.g. the control room, which
  // has no join-room action). Encrypted like everything else — the relay never
  // sees it.
  room_kind?: RoomKind;
  // Number of agents the daemon currently has running. Stamped on every
  // control-room reply (alongside `room_kind: 'control'`) so the phone's
  // command-bar badge reflects daemon-side truth instead of guessing from
  // local state — which can't tell whether the user has tapped Join, and
  // gets no signal when an agent is killed server-side. Encrypted like the
  // rest of the envelope.
  agent_count?: number;
  // Suggested display name for the room the message lives in. Phone uses
  // this as the nickname ONLY if none is set yet — never overrides a user
  // rename. Used by the daemon to auto-name the control room (the host
  // machine's hostname) since the QR-pairing flow gives the phone no
  // other channel to learn a name for it.
  room_name?: string;
  // Transient work indicator (NOT a chat message). When set, the payload carries
  // a `status` envelope and `ephemeral` marks the send so the server publishes it
  // as a `status` event and skips the outbox — it never persists or replays. The
  // phone renders one in-place "agent is working" bubble, updates it on each
  // status, and clears it on the terminal `done`/`failed`. `seq` is a per-agent
  // monotonic counter so the phone can discard a status that arrives out of order.
  status?: { state: string; seq: number };
  ephemeral?: boolean;
};

export const encryptAndSend = async (
  server: string,
  roomHash: string,
  token: string,
  messageKey: CryptoKey,
  text: string,
  options?: SendOptions
): Promise<void> => {
  const msgId = base64UrlEncode(randomBytes(12));
  const payloadObj: Record<string, unknown> = { text, handle: options?.handle ?? 'hisohiso-cli' };
  if (options?.action) {
    payloadObj.action = options.action;
  }
  if (options?.blocks && options.blocks.length > 0) {
    payloadObj.blocks = options.blocks;
  }
  if (options?.room_kind) {
    payloadObj.room_kind = options.room_kind;
  }
  if (typeof options?.agent_count === 'number') {
    payloadObj.agent_count = options.agent_count;
  }
  if (typeof options?.room_name === 'string' && options.room_name !== '') {
    payloadObj.room_name = options.room_name;
  }
  if (options?.status) {
    payloadObj.status = options.status;
  }
  const payload = JSON.stringify(payloadObj);
  const encrypted = await encryptText(messageKey, roomHash, 'chat', msgId, payload);
  await api.sendMessage(server, roomHash, token, msgId, JSON.stringify(encrypted), options?.ephemeral === true);
};

export const bridgeAgentToRoom = async (
  agent: AgentHandle,
  server: string,
  roomHash: string,
  token: string,
  subscriberJwt: string,
  messageKey: CryptoKey,
  options?: {
    onParsedLine?: (parsed: ParsedLine) => void;
    onInbound?: (text: string) => void;
  }
): Promise<{ sse: SSESubscription; presence: PresenceHandle; close: () => void }> => {
  const ownTokenHash = await sha256Hex(token);

  // Output buffer: accumulate chat lines and flush periodically
  let chatBuffer: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushChatBuffer = async () => {
    if (chatBuffer.length === 0) return;
    const text = chatBuffer.join('\n');
    chatBuffer = [];
    try {
      await encryptAndSend(server, roomHash, token, messageKey, text);
    } catch (err) {
      console.error('[bridge] failed to send chat buffer:', err);
    }
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await flushChatBuffer();
    }, FLUSH_INTERVAL_MS);
  };

  // Agent stdout/stderr -> room
  agent.onLine(async (line, isStderr) => {
    const parsed = parseLine(line, isStderr);
    options?.onParsedLine?.(parsed);

    if (parsed.tag === 'CHAT') {
      chatBuffer.push(parsed.text);
      if (chatBuffer.length >= FLUSH_MAX_LINES) {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        await flushChatBuffer();
      } else {
        scheduleFlush();
      }
    } else {
      // Flush any pending chat before sending a tagged message
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      await flushChatBuffer();

      const msgId = base64UrlEncode(randomBytes(12));
      const msgPayload: Record<string, unknown> = {
        text: parsed.text,
        handle: 'hisohiso-cli',
        tag: parsed.tag,
      };
      if (parsed.options) {
        msgPayload.options = parsed.options;
      }
      const encrypted = await encryptText(messageKey, roomHash, 'chat', msgId, JSON.stringify(msgPayload));
      try {
        await api.sendMessage(server, roomHash, token, msgId, JSON.stringify(encrypted));
      } catch (err) {
        console.error('[bridge] failed to send tagged message:', err);
      }
    }
  });

  // Room messages -> agent stdin
  const sse = subscribeToRoom(server, roomHash, subscriberJwt, {
    onChat: async (event: RoomEvent) => {
      // Filter own messages
      if (event.from === ownTokenHash) return;

      try {
        const encPayload = typeof event.body.encrypted_payload === 'string'
          ? JSON.parse(event.body.encrypted_payload) as EncryptedPayload
          : event.body.encrypted_payload as EncryptedPayload;
        const msgId = (event.body.msg_id as string) || '';
        const decrypted = await decryptText(messageKey, roomHash, 'chat', msgId, encPayload);
        const parsed = JSON.parse(decrypted) as {
          text: string;
          handle?: string;
          tag?: string;
          reply_to?: { msg_id?: string; quote?: string };
          replies?: Array<{ text?: string; reply_to?: { msg_id?: string; quote?: string } }>;
        };
        const text = parsed.text;

        console.error(`[bridge] inbound from phone: ${text.slice(0, 80)}`);
        options?.onInbound?.(text);

        // Check if it's a control message (shouldn't be in agent rooms, but handle gracefully)
        const ctrl = decodeControlMessage(text);
        if (ctrl) return;

        // A batch of replies: feed the whole set as ONE stdin write so the agent
        // reads them together and acts in context, rather than one queued line
        // winning while the rest wait behind it.
        if (Array.isArray(parsed.replies) && parsed.replies.length > 0) {
          const lines = parsed.replies
            .filter((r) => r && typeof r.text === 'string')
            .map((r) => {
              const q = r.reply_to?.quote ? ` (re: "${quoteForAgent(r.reply_to.quote)}")` : '';
              return `↳${q} ${r.text}`;
            });
          const label = lines.length === 1 ? 'reply' : 'replies';
          agent.writeStdin(`[FROM USER · ${lines.length} ${label}]\n${lines.join('\n')}\n`);
          return;
        }

        // A single reply carries the message it answers as quoted context.
        const replyCtx = parsed.reply_to?.quote ? ` (re: "${quoteForAgent(parsed.reply_to.quote)}")` : '';

        // Feed to agent stdin
        const lower = text.toLowerCase().trim();
        if (!replyCtx && (lower === 'yes' || lower === 'no')) {
          agent.writeStdin(`${lower}\n`);
        } else {
          agent.writeStdin(`[FROM USER${replyCtx}] ${text}\n`);
        }
      } catch (err) {
        console.error('[bridge] failed to process inbound message:', err);
      }
    },
    onOpen: () => {
      console.error('[bridge] SSE connected to room');
    },
    onError: (err) => {
      console.error('[bridge] SSE error:', err);
    },
  });

  const presence = startPresence(server, roomHash, token);

  const close = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    sse.close();
    presence.stop();
  };

  return { sse, presence, close };
};
