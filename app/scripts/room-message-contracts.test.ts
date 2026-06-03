import {
  parseRoomEnvelope,
  toChatMessageRecord,
  getMessagePreview,
  formatBlockResponse,
  mergeChatMessageEcho,
  type RoomEnvelope,
} from '../src/lib/room-message.js';

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const envelope = parseRoomEnvelope(JSON.stringify({
  text: 'Deploy finished',
  handle: 'agent',
  action: { type: 'join-room', roomSecret: 'abc', label: 'Join agent' },
  blocks: [{ type: 'progress', title: 'Deploy', steps: [{ label: 'Build', status: 'active' }] }],
  block_response: { block_id: 'choice', type: 'buttons', value: ['yes', 'ship'] },
})) as RoomEnvelope;

assert(envelope.text === 'Deploy finished', 'envelope text should be parsed');
assert(envelope.handle === 'agent', 'envelope handle should be parsed');
assert(envelope.action?.type === 'join-room', 'join-room action should be preserved');
assert(envelope.blocks?.[0]?.type === 'progress', 'blocks should be preserved');
assert(envelope.block_response?.block_id === 'choice', 'block response should be preserved');

const record = toChatMessageRecord({
  msgId: 'msg-1',
  roomHash: 'room-hash',
  timestamp: 12345,
  from: 'peer-token-hash',
  plaintext: JSON.stringify(envelope),
  ownTokenHash: 'own-token-hash',
});

assert(record.content === 'Deploy finished', 'record content should use envelope text');
assert(record.direction === 'in', 'peer messages should be incoming');
assert(record.handle === 'agent', 'record handle should use envelope handle');
assert(record.blocks?.length === 1, 'record should carry renderable blocks');
assert(record.block_response?.value instanceof Array, 'record should carry block responses');

const ownRecord = toChatMessageRecord({
  msgId: 'msg-2',
  roomHash: 'room-hash',
  timestamp: 12346,
  from: 'own-token-hash',
  plaintext: 'plain text',
  ownTokenHash: 'own-token-hash',
});
assert(ownRecord.direction === 'out', 'own token hash should mark outgoing messages');
assert(ownRecord.content === 'plain text', 'plain text should be preserved');

assert(getMessagePreview(' hello\nworld '.repeat(20)).length <= 163, 'message preview should be compact and bounded');
assert(formatBlockResponse(record) === 'Selected: yes, ship', 'block response labels should be stable');

// Swipe responses carry a { cardValue: 'good' | 'bad' } map — it must render as
// readable text, never "[object Object]".
const swipeLabel = formatBlockResponse({
  block_response: { block_id: 'approach', type: 'swipe', value: { 'plan-a': 'good', 'plan-b': 'bad', 'plan-c': 'good' } },
});
assert(swipeLabel === 'Chose: 👍 plan-a, plan-c  👎 plan-b', `swipe response should group verdicts, got: ${swipeLabel}`);
assert(!swipeLabel!.includes('[object Object]'), 'swipe response must not stringify to [object Object]');

const optimisticOwn = {
  id: 'echo-1',
  room_hash: 'room-hash',
  timestamp: 2000,
  content: 'user typed this',
  type: 'chat' as const,
  direction: 'out' as const,
  from: 'own-token-hash',
  handle: null,
};
const misclassifiedEcho = {
  ...optimisticOwn,
  timestamp: 1000,
  direction: 'in' as const,
  from: 'own-token-hash',
  handle: 'agent',
};
const mergedEcho = mergeChatMessageEcho(optimisticOwn, misclassifiedEcho);
assert(mergedEcho.direction === 'out', 'server echo should preserve optimistic outgoing authorship');
assert(mergedEcho.handle === null, 'server echo should not relabel an own message with inbound handle');
assert(mergedEcho.timestamp === 1000, 'server echo should still adopt server timestamp');

// A single selection mirrors into block_responses so consumers can read either.
assert(envelope.block_responses?.length === 1, 'single block_response should mirror into block_responses');
assert(envelope.block_responses?.[0]?.block_id === 'choice', 'mirrored batch should preserve the response');

// A multi-block batch round-trips through block_responses and leaves the
// singular field null; formatBlockResponse joins one label per selection.
const batchEnvelope = parseRoomEnvelope(JSON.stringify({
  text: '[buttons] ship\n[slider] 30',
  handle: 'operator',
  block_responses: [
    { block_id: 'deploy', type: 'buttons', value: 'ship' },
    { block_id: 'scope', type: 'slider', value: 30 },
  ],
})) as RoomEnvelope;

assert(batchEnvelope.block_responses?.length === 2, 'batch should carry every selection');
assert(batchEnvelope.block_response === null, 'multi-block batch should leave singular block_response null');

const batchRecord = toChatMessageRecord({
  msgId: 'msg-3',
  roomHash: 'room-hash',
  timestamp: 12347,
  from: 'own-token-hash',
  plaintext: JSON.stringify(batchEnvelope),
  ownTokenHash: 'own-token-hash',
});
assert(batchRecord.block_responses?.length === 2, 'record should carry the batched responses');
assert(formatBlockResponse(batchRecord) === 'Selected: ship\nSet to: 30', 'batch labels should join one per line');

// A single reply carries reply_to inside the envelope; the record keeps it and
// leaves the batch field null.
const replyEnvelope = parseRoomEnvelope(JSON.stringify({
  text: 'Update the tests.',
  handle: 'operator',
  reply_to: { msg_id: 'm2', quote: 'update the tests or flag the old path?' },
})) as RoomEnvelope;
assert(replyEnvelope.reply_to?.msg_id === 'm2', 'reply_to msg_id should be parsed');
assert(replyEnvelope.reply_to?.quote === 'update the tests or flag the old path?', 'reply_to quote should be parsed');

const replyRecord = toChatMessageRecord({
  msgId: 'r-1', roomHash: 'room-hash', timestamp: 5,
  from: 'own-token-hash', plaintext: JSON.stringify(replyEnvelope), ownTokenHash: 'own-token-hash',
});
assert(replyRecord.reply_to?.msg_id === 'm2', 'record should carry reply_to');
assert(replyRecord.replies == null, 'a single reply should leave replies null');

// An oversized quote is re-bounded through getMessagePreview so payloads and
// stored records can't bloat.
const boundedReply = parseRoomEnvelope(JSON.stringify({
  text: 'ok', reply_to: { msg_id: 'm9', quote: 'x'.repeat(500) },
})) as RoomEnvelope;
assert((boundedReply.reply_to?.quote.length ?? 999) <= 163, 'reply quote should be bounded');

// A malformed reply_to (no msg_id) is dropped, never thrown.
const noRef = parseRoomEnvelope(JSON.stringify({ text: 'hi', reply_to: { quote: 'no id' } })) as RoomEnvelope;
assert(noRef.reply_to === null, 'reply_to without msg_id should be dropped');

// A batch keeps only valid entries and round-trips into the record.
const batchReplies = parseRoomEnvelope(JSON.stringify({
  text: '2 replies',
  handle: 'operator',
  replies: [
    { text: 'Update the tests.', reply_to: { msg_id: 'm2', quote: 'update tests?' } },
    { text: 'Yes, env var.', reply_to: { msg_id: 'm3', quote: 'move URL to env?' } },
    { text: 'dropped — no ref' },
    { reply_to: { msg_id: 'm4', quote: 'q' } },
  ],
})) as RoomEnvelope;
assert(batchReplies.replies?.length === 2, 'batch should keep only valid reply entries');
assert(batchReplies.replies?.[0]?.text === 'Update the tests.', 'batch entry text should be parsed');
assert(batchReplies.replies?.[1]?.reply_to.msg_id === 'm3', 'batch entry reply_to should be parsed');

const batchReplyRecord = toChatMessageRecord({
  msgId: 'r-batch', roomHash: 'room-hash', timestamp: 6,
  from: 'own-token-hash', plaintext: JSON.stringify(batchReplies), ownTokenHash: 'own-token-hash',
});
assert(batchReplyRecord.replies?.length === 2, 'record should carry the batched replies');

// Legacy raw text and non-reply envelopes are unaffected.
assert(record.reply_to == null, 'non-reply record should have null reply_to');
assert(ownRecord.replies == null, 'legacy raw-text record should have no replies');

console.log('room message contracts OK');
