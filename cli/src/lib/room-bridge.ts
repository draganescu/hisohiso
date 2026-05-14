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

export const createRoomAndJoin = async (
  server: string,
  password = ''
): Promise<{ roomSecret: string; roomHash: string; participantToken: string; messageKey: CryptoKey }> => {
  const roomSecret = generateRoomSecret();
  const roomHash = await deriveRoomHash(roomSecret);
  const result = await api.createRoom(server, roomHash);
  if (!result.participant_token) {
    throw new Error('Failed to create room: no token returned');
  }
  const messageKey = await deriveMessageKey(roomSecret, password);
  return { roomSecret, roomHash, participantToken: result.participant_token, messageKey };
};

export type SendOptions = {
  handle?: string;
  action?: { type: string; roomSecret: string; label: string };
  blocks?: unknown[];
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
  const payload = JSON.stringify(payloadObj);
  const encrypted = await encryptText(messageKey, roomHash, 'chat', msgId, payload);
  await api.sendMessage(server, roomHash, token, msgId, JSON.stringify(encrypted));
};

export const bridgeAgentToRoom = async (
  agent: AgentHandle,
  server: string,
  roomHash: string,
  token: string,
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
  const sse = subscribeToRoom(server, roomHash, {
    onChat: async (event: RoomEvent) => {
      // Filter own messages
      if (event.from === ownTokenHash) return;

      try {
        const encPayload = typeof event.body.encrypted_payload === 'string'
          ? JSON.parse(event.body.encrypted_payload) as EncryptedPayload
          : event.body.encrypted_payload as EncryptedPayload;
        const msgId = (event.body.msg_id as string) || '';
        const decrypted = await decryptText(messageKey, roomHash, 'chat', msgId, encPayload);
        const parsed = JSON.parse(decrypted) as { text: string; handle?: string; tag?: string };
        const text = parsed.text;

        console.error(`[bridge] inbound from phone: ${text.slice(0, 80)}`);
        options?.onInbound?.(text);

        // Check if it's a control message (shouldn't be in agent rooms, but handle gracefully)
        const ctrl = decodeControlMessage(text);
        if (ctrl) return;

        // Feed to agent stdin
        const lower = text.toLowerCase().trim();
        if (lower === 'yes' || lower === 'no') {
          agent.writeStdin(`${lower}\n`);
        } else {
          agent.writeStdin(`[FROM USER] ${text}\n`);
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
