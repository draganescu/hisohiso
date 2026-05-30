import type { Block, BlockResponse } from './blocks';
import type { ChatMessage, MessageAction } from './db';

export type RoomEnvelope = {
  text: string;
  handle?: string | null;
  action?: MessageAction | null;
  blocks?: Block[] | null;
  block_response?: BlockResponse | null;
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

// Render any block_response value as a readable string. Objects (e.g. the
// swipe verdict map) would otherwise stringify to "[object Object]".
const formatBlockValue = (val: BlockResponse['value']): string => {
  if (Array.isArray(val)) return val.join(', ');
  if (val && typeof val === 'object') {
    return Object.entries(val)
      .map(([key, v]) => `${key}: ${v}`)
      .join(', ');
  }
  return String(val);
};

// Swipe responses are a { cardValue: 'good' | 'bad' } map. Group them into
// liked / disliked lists instead of dumping the raw object.
const formatSwipeVerdicts = (val: BlockResponse['value']): string | null => {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return null;
  const entries = Object.entries(val);
  const liked = entries.filter(([, v]) => v === 'good').map(([k]) => k);
  const disliked = entries.filter(([, v]) => v === 'bad').map(([k]) => k);
  const parts: string[] = [];
  if (liked.length) parts.push(`👍 ${liked.join(', ')}`);
  if (disliked.length) parts.push(`👎 ${disliked.join(', ')}`);
  return parts.length ? parts.join('  ') : 'nothing';
};

export const formatBlockResponse = (msg: Pick<ChatMessage, 'block_response'>): string | null => {
  const br = msg.block_response;
  if (!br) return null;
  const val = br.value;
  const label = formatBlockValue(val);
  switch (br.type) {
    case 'buttons': return `Selected: ${label}`;
    case 'swipe': return `Chose: ${formatSwipeVerdicts(val) ?? label}`;
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

  if (plaintext.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(plaintext) as {
        text?: string;
        handle?: string | null;
        action?: MessageAction;
        blocks?: Block[];
        block_response?: BlockResponse;
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
