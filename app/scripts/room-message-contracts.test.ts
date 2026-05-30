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

console.log('room message contracts OK');
