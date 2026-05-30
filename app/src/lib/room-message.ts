import type { Block, BlockResponse } from './blocks';
import type { ChatMessage, MessageAction } from './db';

export type RoomEnvelope = {
  text: string;
  handle?: string | null;
  action?: MessageAction | null;
  blocks?: Block[] | null;
  /** Single-selection reply. Kept for the daemon control-room routing and for
   *  rendering one-block answers. Always mirrors block_responses[0] when the
   *  batch holds exactly one entry. */
  block_response?: BlockResponse | null;
  /** Batched replies: every interactive block the operator answered in one
   *  agent message, sent together so they arrive as a single message. */
  block_responses?: BlockResponse[] | null;
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

const formatOneBlockResponse = (br: BlockResponse): string => {
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

export const formatBlockResponse = (msg: Pick<ChatMessage, 'block_response' | 'block_responses'>): string | null => {
  const list = msg.block_responses && msg.block_responses.length > 0
    ? msg.block_responses
    : msg.block_response
    ? [msg.block_response]
    : [];
  if (list.length === 0) return null;
  return list.map(formatOneBlockResponse).join('\n');
};

export const parseRoomEnvelope = (plaintext: string): RoomEnvelope => {
  let messageText = plaintext;
  let messageHandle: string | null = null;
  let messageAction: MessageAction | null = null;
  let messageBlocks: Block[] | null = null;
  let messageBlockResponse: BlockResponse | null = null;
  let messageBlockResponses: BlockResponse[] | null = null;

  if (plaintext.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(plaintext) as {
        text?: string;
        handle?: string | null;
        action?: MessageAction;
        blocks?: Block[];
        block_response?: BlockResponse;
        block_responses?: BlockResponse[];
      };
      if (typeof obj.text === 'string') messageText = obj.text;
      if (typeof obj.handle === 'string') messageHandle = obj.handle;
      if (obj.action && typeof obj.action === 'object' && obj.action.type === 'join-room' && typeof obj.action.roomSecret === 'string') {
        messageAction = obj.action;
      }
      if (Array.isArray(obj.blocks) && obj.blocks.length > 0) messageBlocks = obj.blocks;
      if (Array.isArray(obj.block_responses)) {
        const valid = obj.block_responses.filter(
          (r): r is BlockResponse => !!r && typeof r === 'object' && typeof r.block_id === 'string'
        );
        if (valid.length > 0) messageBlockResponses = valid;
      }
      if (obj.block_response && typeof obj.block_response === 'object' && obj.block_response.block_id) {
        messageBlockResponse = obj.block_response;
      }
    } catch {
      messageText = plaintext;
    }
  }

  // Keep singular/plural mirrored so consumers can read either field: a single
  // selection populates both; a multi-block batch fills the array and leaves
  // block_response null.
  if (!messageBlockResponses && messageBlockResponse) {
    messageBlockResponses = [messageBlockResponse];
  }
  if (!messageBlockResponse && messageBlockResponses && messageBlockResponses.length === 1) {
    messageBlockResponse = messageBlockResponses[0];
  }

  return {
    text: messageText,
    handle: messageHandle,
    action: messageAction,
    blocks: messageBlocks,
    block_response: messageBlockResponse,
    block_responses: messageBlockResponses,
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
    block_responses: envelope.block_responses ?? null,
  };
};
