import type { Block, BlockResponse } from './blocks';
import type { ChatMessage, MessageAction } from './db';
import type { RoomKind } from './storage';

// Local guard (kept here rather than imported as a value from storage) so this
// module has no runtime dependency on storage — storage touches localStorage,
// and the room-message contract test compiles this file in isolation.
const isRoomKindValue = (value: unknown): value is RoomKind =>
  value === 'chat' || value === 'control' || value === 'agent';

export type RoomEnvelope = {
  text: string;
  handle?: string | null;
  action?: MessageAction | null;
  blocks?: Block[] | null;
  block_response?: BlockResponse | null;
  // Room-kind discriminator stamped by the daemon on its control-room
  // messages. Lets the phone learn that a QR-paired room is the control room
  // (there is no join-room action for it). null when the sender didn't stamp.
  room_kind?: RoomKind | null;
  // Number of agents the daemon currently has running. Stamped on every
  // control-room reply. The phone reads it to power the command-bar Agents
  // badge — daemon truth, not a local guess. null when the sender didn't
  // stamp (e.g. peer chat messages, or pre-update daemons).
  agent_count?: number | null;
};

export type ChatMessageRecordInput = {
  msgId: string;
  roomHash: string;
  timestamp: number;
  from?: string | null;
  plaintext: string;
  ownTokenHash?: string | null;
};

export const getMessagePreview = (content: string): string => {
  const normalized = content.replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return 'Empty message';
  }
  const compact = normalized
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trimEnd())
    .join('\n');
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
};

export const formatBlockResponse = (msg: Pick<ChatMessage, 'block_response'>): string | null => {
  const br = msg.block_response;
  if (!br) return null;
  const val = br.value;
  const label = Array.isArray(val) ? val.join(', ') : String(val);
  switch (br.type) {
    case 'buttons': return `Selected: ${label}`;
    case 'swipe': return `Chose: ${label}`;
    case 'slider': return `Set to: ${label}`;
    case 'checklist': return `Checked: ${label}`;
    case 'sortable': return `Order: ${label}`;
    case 'confirm-danger': return val ? 'Confirmed' : 'Cancelled';
    case 'commit': return label === 'commit' ? 'Committed' : label === 'edit' ? 'Editing' : 'Cancelled';
    case 'run-command': return label === 'run' ? 'Running command' : 'Skipped';
    default: return label;
  }
};

export const parseRoomEnvelope = (plaintext: string): RoomEnvelope => {
  let messageText = plaintext;
  let messageHandle: string | null = null;
  let messageAction: MessageAction | null = null;
  let messageBlocks: Block[] | null = null;
  let messageBlockResponse: BlockResponse | null = null;
  let messageRoomKind: RoomKind | null = null;
  let messageAgentCount: number | null = null;

  if (plaintext.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(plaintext) as {
        text?: string;
        handle?: string | null;
        action?: MessageAction;
        blocks?: Block[];
        block_response?: BlockResponse;
        room_kind?: unknown;
        agent_count?: unknown;
      };
      if (typeof obj.text === 'string') messageText = obj.text;
      if (typeof obj.handle === 'string') messageHandle = obj.handle;
      if (obj.action && typeof obj.action === 'object' && obj.action.type === 'join-room' && typeof obj.action.roomSecret === 'string') {
        messageAction = obj.action;
      }
      if (Array.isArray(obj.blocks) && obj.blocks.length > 0) messageBlocks = obj.blocks;
      if (obj.block_response && typeof obj.block_response === 'object' && obj.block_response.block_id) {
        messageBlockResponse = obj.block_response;
      }
      if (isRoomKindValue(obj.room_kind)) messageRoomKind = obj.room_kind;
      // Accept non-negative finite integers only — anything else is malformed
      // input we'd rather ignore than render. A peer chat message could
      // plausibly carry an unrelated `agent_count` field; the value-shape
      // guard plus the room-kind === 'control' check at the call site keep
      // that from leaking into the control-room badge.
      if (typeof obj.agent_count === 'number' && Number.isInteger(obj.agent_count) && obj.agent_count >= 0) {
        messageAgentCount = obj.agent_count;
      }
    } catch {
      messageText = plaintext;
    }
  }

  return {
    text: messageText,
    handle: messageHandle,
    action: messageAction,
    blocks: messageBlocks,
    block_response: messageBlockResponse,
    room_kind: messageRoomKind,
    agent_count: messageAgentCount,
  };
};

export const toChatMessageRecord = ({
  msgId,
  roomHash,
  timestamp,
  from,
  plaintext,
  ownTokenHash,
}: ChatMessageRecordInput): ChatMessage => {
  const envelope = parseRoomEnvelope(plaintext);
  return {
    id: msgId,
    room_hash: roomHash,
    timestamp,
    content: envelope.text,
    type: 'chat',
    direction: ownTokenHash && from === ownTokenHash ? 'out' : 'in',
    from: from ?? null,
    handle: envelope.handle ?? null,
    action: envelope.action ?? null,
    blocks: envelope.blocks ?? null,
    block_response: envelope.block_response ?? null,
  };
};
