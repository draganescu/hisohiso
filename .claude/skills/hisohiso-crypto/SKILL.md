---
name: hisohiso-crypto
description: Reference for hisohiso's end-to-end encryption protocol — key derivation, the knock/approve/token handshake, message encryption, and auth. Load before touching any crypto, room, knock, token, or KDF code so you don't silently weaken or break the protocol.
metadata:
  type: reference
---

# hisohiso crypto protocol (reference)

Privacy rests on one invariant: **the room secret never leaves the browser.**
Everything is derived from it on-device (Web Crypto / `crypto.subtle`). The
server only ever holds **hashes and ciphertext**. Authoritative prose:
`docs/encryption.md`. Implementations: client `app/` + `cli/src/lib/crypto.ts`,
server `server/index.php`.

## Identifiers & derivation

- `room_secret` — 32 random bytes. Lives only in the URL hash (`/room#SECRET`).
- `room_hash = SHA-256("hisohiso.room_hash" + room_secret)` — the only room id
  the server sees. Must match `^[0-9a-f]{64}$` or the API rejects with
  `invalid_room_hash`.
- Message key:
  `k_msg = PBKDF2-HMAC-SHA256(password = pairing_code,
  salt = SHA-256("hisohiso.kdf.v1.k_msg" || 0x00 || room_secret),
  iterations = 600000)` (finding #93; `kdfVersion = 1`).

## Message encryption

- AES-256-GCM. `nonce` = 12 unique bytes per message.
- **AAD = `room_hash + msg_type + msg_id`** — keep this exact; it binds
  ciphertext to its room, type, and id.
- The server stores/forwards only the opaque `encrypted_payload`.

## Knock → approve → token handshake (joining)

1. **knock** — the joiner makes an ephemeral **ECDH P-256** keypair, sends the
   SPKI public key as `knock_pubkey`, keeps the private key in memory. Gets a
   short-TTL (~10 min) lobby subscriber JWT.
2. **approve** — an existing participant approves; the published `approve` event
   has an **empty body** (the token is delivered out-of-band).
3. **token** — the approver makes its own ephemeral ECDH keypair, derives a
   shared secret with `knock_pubkey` via **HKDF-SHA256, info `"hisohiso.token_wrap"`**,
   AES-256-GCM-encrypts the participant token, and posts `{knock_msg_id,
   approver_pubkey, nonce, ct}`. Only the joiner (holding the matching private
   key) can decrypt it.

## Auth & transport

- **Participant token** — 32 random bytes; server stores only `SHA-256(token)`.
  Sent on every authed request as header **`X-Chat-Token`** (hashed + compared).
- **Mercure subscriber JWT** — scoped to `room:{room_hash}`; ~7d for
  participants, ~10 min for lobby. Refresh via `POST /rooms/{hash}/sub-token`.

## Rules of thumb when editing crypto

- Never send `room_secret`, `pairing_code`, `participant_token`, or derived keys
  to the server or into logs. The `bash`/custom-agent profiles deliberately do
  NOT get `HISOHISO_ROOM_SECRET` unless `--needs-room-secret` (finding #97).
- Don't change a label/salt/info string or the AAD layout without bumping the
  KDF/version and handling old rooms — it silently breaks decryption.
- Keep PBKDF2 iterations at 600k+; don't downgrade pairing-code entropy.
