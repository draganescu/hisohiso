import {
  parseRoomEnvelope,
  toChatMessageRecord,
  getMessagePreview,
  formatBlockResponse,
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

console.log('room message contracts OK');
