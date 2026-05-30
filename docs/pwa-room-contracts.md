# PWA room compatibility contracts

This file is the redesign guardrail for the room PWA. A visual rewrite should keep these contracts stable unless it intentionally migrates persisted clients.

## URL and local state

- Room identity is carried in `/room#<roomSecret>`.
- `deriveRoomHash(roomSecret)` is the server-visible room id.
- Local participant data is keyed by room hash:
  - `hisohiso.token.<roomHash>` participant token
  - `hisohiso.subjwt.<roomHash>` Mercure subscriber JWT
  - `hisohiso.handle.<roomHash>` display handle
  - `hisohiso.room_password.<roomHash>` room pairing/password material
  - `hisohiso.rooms` recent-room index with `roomSecret`, `roomHash`, `lastSeen`, optional `handle`, `nickname`, `color`
- Chat messages are persisted in IndexedDB database `hisohiso`, table `messages`, indexed by `[room_hash+timestamp]`.

## Server API used by the PWA

- `GET /api/rooms/:hash` returns room existence, participant presence, and catch-up setting.
- `POST /api/rooms/:hash/presence` requires `X-Chat-Token` and refreshes participant presence.
- `POST /api/rooms/:hash/sub-token` requires `X-Chat-Token` and returns a fresh Mercure subscriber JWT.
- `POST /api/rooms/:hash/knock` sends encrypted knock payload plus `knock_pubkey`, returning a lobby-scoped JWT.
- `POST /api/rooms/:hash/approve` requires participant token and returns a pending participant token plus subscriber JWT for wrapping to the knocker.
- `POST /api/rooms/:hash/token` publishes the wrapped participant bundle to the lobby topic.
- `POST /api/rooms/:hash/message` publishes `{ msg_id, encrypted_payload }` to the members topic.
- `GET /api/rooms/:hash/outbox?since_ts=<ms>` returns missed encrypted messages when catch-up is enabled.
- `POST /api/rooms/:hash/settings` toggles catch-up and publishes a settings event.
- `POST /api/rooms/:hash/leave` revokes the current participant.
- `POST /api/rooms/:hash/disband` destroys the room.

## SSE events

All events include `{ v, type, room_hash, from?, ts, body }`. Member JWTs subscribe to the members topic; lobby JWTs subscribe to the lobby topic.

- `chat`: `body.encrypted_payload`, `body.msg_id`
- `knock`: `body.encrypted_payload`, `body.msg_id`, `body.knock_pubkey`
- `token`: `body.knock_msg_id`, `body.approver_pubkey`, `body.nonce`, `body.ct`
- `reject`: lobby rejection tombstone
- `destroy`: room tombstone
- `settings`: `body.catch_up_enabled`

## Plaintext chat envelope

After decrypting a `chat` event, the plaintext is either raw text or a JSON envelope:

```json
{
  "text": "lock-screen readable text",
  "handle": "optional sender handle",
  "action": { "type": "join-room", "roomSecret": "...", "label": "...", "code": "optional", "roomName": "optional" },
  "blocks": [{ "type": "buttons" }],
  "block_response": { "block_id": "id", "type": "buttons", "value": "selected" },
  "block_responses": [{ "block_id": "id", "type": "buttons", "value": "selected" }]
}
```

When one agent message carries several interactive blocks, the phone gathers
every selection and sends them together in a single message via
`block_responses`. This avoids the earlier behaviour where each block was posted
as its own message — the first reply reached the agent while the rest queued
behind it. A lone selection populates both `block_responses` (one entry) and
`block_response`; a multi-block batch fills `block_responses` and leaves
`block_response` null. The parser mirrors a single entry across both fields so
consumers may read either.

The parser in `src/lib/room-message.ts` is the compatibility boundary between protocol payloads and renderable `ChatMessage` records.
