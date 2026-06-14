import Dexie, { type Table } from 'dexie';
import type { Block, BlockResponse } from './blocks';
import type { RoomKind } from './storage';

export type MessageAction = {
  type: 'join-room';
  roomSecret: string;
  label: string;
  // 4-digit pairing code minted by the CLI for this agent room. The operator
  // reads it off the message and types it as the room password on join. Only
  // present on rooms minted by daemons that ship the pairing-code protection.
  code?: string;
  // Optional local-only room name suggested by the sender. Used by the
  // daemon control room to name freshly spawned agent rooms on the phone.
  roomName?: string;
  // Kind of the room being joined, so the phone stamps it correctly on join.
  // Daemon-spawned agent rooms carry 'agent'.
  room_kind?: RoomKind;
  // For agent-room join actions: the roomHash of the control room (daemon) that
  // spawned this agent. Lets the phone group the agent under its daemon
  // authoritatively, regardless of where the Join was tapped from. Daemons
  // predating this field omit it — the phone then falls back to inferring the
  // parent from the control room the Join was tapped in (see joinActionRoom).
  controlRoomHash?: string;
};

// A reply's pointer to the message it answers. The quote is a bounded preview
// of that message, embedded so the reply stays legible even when the original
// isn't on this device (catch-up gaps). Lives inside the encrypted payload —
// the relay never sees which message answers which.
export type ReplyRef = {
  msg_id: string;
  quote: string;
};

// One reply in a batch: the text plus what it answers. A single human reply is
// a normal message carrying reply_to; an agent-room batch carries many of these
// in `replies`, the free-text twin of block_responses.
export type ReplyEntry = {
  text: string;
  reply_to: ReplyRef;
};

export type ChatMessage = {
  id: string;
  room_hash: string;
  timestamp: number;
  content: string;
  type: 'chat' | 'system';
  direction: 'in' | 'out';
  from?: string | null;
  handle?: string | null;
  action?: MessageAction | null;
  blocks?: Block[] | null;
  block_response?: BlockResponse | null;
  block_responses?: BlockResponse[] | null;
  // Single reply: this message answers reply_to. Shared with human chat (#141).
  reply_to?: ReplyRef | null;
  // Agent-room batch: replies the operator collected and dispatched together.
  replies?: ReplyEntry[] | null;
};

class ChatDatabase extends Dexie {
  messages!: Table<ChatMessage, string>;

  constructor() {
    super('hisohiso');
    this.version(1).stores({
      messages: 'id, room_hash, timestamp, [room_hash+timestamp]'
    });
    this.version(2).stores({
      messages: 'id, room_hash, timestamp, [room_hash+timestamp]'
    });
    // v3: convert legacy second-precision timestamps to ms so they keep their
    // wall-clock meaning after the server + outgoing-message change. Without
    // this, every cached message would render as Jan 1970 in formatMailStamp.
    this.version(3).stores({
      messages: 'id, room_hash, timestamp, [room_hash+timestamp]'
    }).upgrade(async (tx) => {
      await tx.table<ChatMessage>('messages').toCollection().modify((msg) => {
        msg.timestamp = msg.timestamp * 1000;
      });
    });
  }
}

export const db = new ChatDatabase();

export const loadMessages = async (roomHash: string): Promise<ChatMessage[]> => {
  return db.messages
    .where('[room_hash+timestamp]')
    .between([roomHash, Dexie.minKey], [roomHash, Dexie.maxKey])
    .sortBy('timestamp');
};

export const saveMessage = async (message: ChatMessage): Promise<void> => {
  await db.messages.put(message);
};

export const deleteMessage = async (id: string): Promise<void> => {
  await db.messages.delete(id);
};

export const clearRoomMessages = async (roomHash: string): Promise<void> => {
  await db.messages.where('room_hash').equals(roomHash).delete();
};

// Metadata for the last-message preview on the /rooms card. This decrypts NOTHING
// new: the latest message is already decrypted on THIS device inside `messages`, so
// we read it locally to show a real one-line preview + timestamp. Nothing here ever
// reaches the server — the relay only ever held ciphertext — so it's a local
// convenience for the operator's own screen, not a leak. Returns null when the room
// has no stored messages yet.
export type LastMessageMeta = {
  timestamp: number;
  /** True if the latest message carries displayable content / blocks / replies. */
  hasContent: boolean;
  /** One-line preview of the latest message, or a short activity summary. */
  preview: string;
  /** True if the latest message was sent from this device (render a "you:" hint). */
  mine: boolean;
  /** True if the latest line is a system/activity notice (render muted). */
  system: boolean;
};

const previewText = (value: string): string => {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
};

export const lastMessageMeta = async (roomHash: string): Promise<LastMessageMeta | null> => {
  const latest = await db.messages
    .where('[room_hash+timestamp]')
    .between([roomHash, Dexie.minKey], [roomHash, Dexie.maxKey])
    .last();
  if (!latest) return null;

  const system = latest.type === 'system';
  let preview = '';
  if (latest.content && latest.content.trim().length > 0) {
    preview = previewText(latest.content);
  } else if (latest.replies && latest.replies.length > 0) {
    const firstText = latest.replies.find((entry) => entry.text && entry.text.trim().length > 0)?.text;
    preview = firstText ? previewText(firstText) : 'replied';
  } else if (latest.blocks && latest.blocks.length > 0) {
    preview = latest.blocks.length === 1 ? 'sent an update' : `sent ${latest.blocks.length} updates`;
  }

  return {
    timestamp: latest.timestamp,
    hasContent: preview.length > 0,
    preview,
    mine: latest.direction === 'out',
    system,
  };
};
