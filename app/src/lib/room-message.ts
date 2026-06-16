import type { Block, BlockResponse } from './blocks';
import type { ChatMessage, MessageAction, ReplyEntry, ReplyRef } from './db';
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
  /** Single-selection reply. Kept for the daemon control-room routing and for
   *  rendering one-block answers. Always mirrors block_responses[0] when the
   *  batch holds exactly one entry. */
  block_response?: BlockResponse | null;
  /** Batched replies: every interactive block the operator answered in one
   *  agent message, sent together so they arrive as a single message. */
  block_responses?: BlockResponse[] | null;
  // Room-kind discriminator stamped by the daemon on its control-room
  // messages. Lets the phone learn that a QR-paired room is the control room
  // (there is no join-room action for it). null when the sender didn't stamp.
  room_kind?: RoomKind | null;
  // Number of agents the daemon currently has running. Stamped on every
  // control-room reply. The phone reads it to power the command-bar Agents
  // badge — daemon truth, not a local guess. null when the sender didn't
  // stamp (e.g. peer chat messages, or pre-update daemons).
  agent_count?: number | null;
  // Suggested display name for the room this message lives in. The daemon
  // stamps the host machine's hostname on every control-room reply so the
  // phone can auto-name the control room (which has no other naming
  // channel — QR pairing carries no metadata). Applied only when no
  // nickname is set; never overrides a user rename.
  room_name?: string | null;
  // Single reply: the message this one answers. Inside the encrypted payload,
  // so the relay never sees the reply graph. Shared with human chat (#141).
  reply_to?: ReplyRef | null;
  // Agent-room batch: replies the operator collected and dispatched as one
  // message — the free-text twin of block_responses.
  replies?: ReplyEntry[] | null;
  // Optional working-context stamp the daemon MAY include on agent/control-room
  // envelopes: the git branch / base branch and the working directory / shell
  // the agent is operating in. Purely cosmetic chrome (a header context line),
  // never linked to identity and never required. null/absent when the sender
  // didn't stamp it (peer chat, pre-update daemon) — the client renders nothing.
  // TODO(server): daemon should populate `context` { branch, base_branch, cwd,
  // shell } on its agent/control-room replies; until then this stays absent and
  // the header context line simply does not render.
  context?: RoomContext | null;
};

// Working-context the daemon may stamp on an agent/control envelope so the phone
// can show "main ← feat/x" or "~/notes · shell" in the header. Every field is
// optional; the client formats whatever subset arrives and renders nothing when
// the whole object is absent. Carries no identity and never crosses the wire
// from the phone.
export type RoomContext = {
  /** Active git branch, e.g. "feat/x". */
  branch?: string | null;
  /** Branch this work targets/merges into, e.g. "main". Renders as "main ← branch". */
  base_branch?: string | null;
  /** Working directory, already abbreviated by the daemon if it likes (e.g. "~/notes"). */
  cwd?: string | null;
  /** Shell / runtime label, e.g. "shell", "zsh". */
  shell?: string | null;
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

// Validate a reply pointer off the wire. The quote is re-bounded through
// getMessagePreview so a malicious or oversized payload can't bloat what we
// store or render. Returns null for anything that isn't a usable pointer.
const parseReplyRef = (val: unknown): ReplyRef | null => {
  if (!val || typeof val !== 'object') return null;
  const ref = val as { msg_id?: unknown; quote?: unknown };
  if (typeof ref.msg_id !== 'string' || ref.msg_id === '') return null;
  const quote = typeof ref.quote === 'string' && ref.quote.trim() !== ''
    ? getMessagePreview(ref.quote)
    : '';
  return { msg_id: ref.msg_id, quote };
};

// Pull a non-empty trimmed string off an unknown field, else null. Keeps the
// context parser from rendering whitespace-only or non-string daemon stamps.
const cleanString = (val: unknown): string | null => {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  return trimmed === '' ? null : trimmed;
};

// Parse the optional working-context stamp. Returns null when the object is
// missing or carries no usable field — so the header context line renders
// nothing rather than an empty pill. Each field is validated independently;
// a daemon may stamp only `cwd`, only `branch`, or any mix.
const parseRoomContext = (val: unknown): RoomContext | null => {
  if (!val || typeof val !== 'object') return null;
  const raw = val as { branch?: unknown; base_branch?: unknown; cwd?: unknown; shell?: unknown };
  const branch = cleanString(raw.branch);
  const baseBranch = cleanString(raw.base_branch);
  const cwd = cleanString(raw.cwd);
  const shell = cleanString(raw.shell);
  if (!branch && !baseBranch && !cwd && !shell) return null;
  return { branch, base_branch: baseBranch, cwd, shell };
};

// The placeholder a secret block-response value is replaced with before it is
// ever written to local history. The real value only ever lives in the
// encrypted wire payload on its way to the agent — never in IndexedDB.
export const SECRET_VALUE_MASK = '[secret hidden]';

// Strip the value of any `secret` block-response so it is never persisted.
// Applied at the single DB write chokepoint, so it covers BOTH the sender's
// outgoing copy and every other room member's inbound copy. Returns the same
// object when there is nothing to redact (no allocation on the common path).
export const redactSecretsForStorage = <T extends Pick<ChatMessage, 'block_response' | 'block_responses'>>(message: T): T => {
  const isSecret = (br: BlockResponse | null | undefined): boolean => !!br && br.type === 'secret';
  const hasSecret = isSecret(message.block_response) || !!message.block_responses?.some(isSecret);
  if (!hasSecret) return message;
  const scrub = (br: BlockResponse): BlockResponse => (br.type === 'secret' ? { ...br, value: SECRET_VALUE_MASK } : br);
  return {
    ...message,
    block_response: message.block_response ? scrub(message.block_response) : message.block_response,
    block_responses: message.block_responses ? message.block_responses.map(scrub) : message.block_responses,
  };
};

// Render any block_response value as a readable string. Objects (e.g. the
// swipe verdict map) would otherwise stringify to "[object Object]".
export const formatBlockValue = (val: BlockResponse['value']): string => {
  if (Array.isArray(val)) return val.join(', ');
  if (val && typeof val === 'object') {
    return Object.entries(val)
      .map(([key, v]) => `${key}: ${v}`)
      .join(', ');
  }
  return String(val);
};

// Format the optional working-context stamp into a single header line. Renders
// the git side as "base ← branch" (or just the branch / base when only one is
// present) and the location side as "cwd · shell" — joining the two sides with
// a middot. Returns null when nothing usable is present, so the caller renders
// no context pill at all. Never invents a value: only fields the daemon stamped
// are shown.
export const formatRoomContext = (ctx: RoomContext | null | undefined): string | null => {
  if (!ctx) return null;
  const gitSide =
    ctx.base_branch && ctx.branch
      ? `${ctx.base_branch} ← ${ctx.branch}`
      : ctx.branch || ctx.base_branch || null;
  const locationSide =
    ctx.cwd && ctx.shell ? `${ctx.cwd} · ${ctx.shell}` : ctx.cwd || ctx.shell || null;
  const parts = [gitSide, locationSide].filter((part): part is string => !!part);
  return parts.length ? parts.join(' · ') : null;
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

const formatOneBlockResponse = (br: BlockResponse): string => {
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
    // Never render a secret's value, even if a stale copy slipped through.
    case 'secret': return 'Secret sent (hidden)';
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
  let messageRoomKind: RoomKind | null = null;
  let messageAgentCount: number | null = null;
  let messageRoomName: string | null = null;
  let messageReplyTo: ReplyRef | null = null;
  let messageReplies: ReplyEntry[] | null = null;
  let messageContext: RoomContext | null = null;

  if (plaintext.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(plaintext) as {
        text?: string;
        handle?: string | null;
        action?: MessageAction;
        blocks?: Block[];
        block_response?: BlockResponse;
        block_responses?: BlockResponse[];
        room_kind?: unknown;
        agent_count?: unknown;
        room_name?: unknown;
        reply_to?: unknown;
        replies?: unknown;
        context?: unknown;
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
      if (isRoomKindValue(obj.room_kind)) messageRoomKind = obj.room_kind;
      // Accept non-negative finite integers only — anything else is malformed
      // input we'd rather ignore than render. A peer chat message could
      // plausibly carry an unrelated `agent_count` field; the value-shape
      // guard plus the room-kind === 'control' check at the call site keep
      // that from leaking into the control-room badge.
      if (typeof obj.agent_count === 'number' && Number.isInteger(obj.agent_count) && obj.agent_count >= 0) {
        messageAgentCount = obj.agent_count;
      }
      if (typeof obj.room_name === 'string') {
        const trimmed = obj.room_name.trim();
        if (trimmed !== '') messageRoomName = trimmed;
      }
      messageReplyTo = parseReplyRef(obj.reply_to);
      if (Array.isArray(obj.replies)) {
        const valid = obj.replies
          .map((entry): ReplyEntry | null => {
            if (!entry || typeof entry !== 'object') return null;
            const e = entry as { text?: unknown; reply_to?: unknown };
            const ref = parseReplyRef(e.reply_to);
            if (!ref || typeof e.text !== 'string' || e.text === '') return null;
            return { text: e.text, reply_to: ref };
          })
          .filter((e): e is ReplyEntry => e !== null);
        if (valid.length > 0) messageReplies = valid;
      }
      // Optional daemon working-context stamp (git branch / cwd). Absent on
      // peer chat and pre-update daemons — parseRoomContext returns null then,
      // and the header context line never renders.
      messageContext = parseRoomContext(obj.context);
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
    room_kind: messageRoomKind,
    agent_count: messageAgentCount,
    room_name: messageRoomName,
    reply_to: messageReplyTo,
    replies: messageReplies,
    context: messageContext,
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
    reply_to: envelope.reply_to ?? null,
    replies: envelope.replies ?? null,
  };
};

export const mergeChatMessageEcho = (existing: ChatMessage, incoming: ChatMessage): ChatMessage => {
  // A server echo of an optimistic local send has the same id but can arrive
  // before ownTokenHash is hydrated, so `incoming` may be misclassified as an
  // inbound peer message. Preserve the already-rendered local authorship and
  // only accept the server clock, which is the reason we process the echo.
  if (existing.timestamp === incoming.timestamp) return existing;
  return { ...existing, timestamp: incoming.timestamp };
};
