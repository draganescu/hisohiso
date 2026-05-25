# Encryption

The whole privacy story rests on one fact: **the room secret never leaves the
browser.** Everything else is derived from it on the device, using the Web
Crypto API (`crypto.subtle`). The server only ever holds hashes and ciphertext.

Client crypto lives in `app/src/lib/crypto.ts`. The PHP side never touches a
plaintext message or a raw secret — it only hashes tokens and signs JWTs.

## What gets derived from the secret

The secret is 32 random bytes (base64url in the URL). From it the client
derives a few independent keys with HKDF-SHA256, each with its own "info"
label so they can't be confused for one another:

```mermaid
flowchart TD
    SECRET[room secret<br/>32 random bytes, in the URL #]
    SECRET -->|SHA-256 'hisohiso.room_hash'| HASH[room_hash<br/>the server's routing key]
    SECRET -->|HKDF 'hisohiso.k_msg'| KMSG[message key<br/>AES-256-GCM]
    SECRET -->|HKDF 'hisohiso.k_knock'| KKNOCK[knock key<br/>AES-256-GCM]
```

- **room_hash** is the only one the server sees. It's a one-way hash, so it
  can't be turned back into the secret or any of the keys.
- **message key** encrypts chat. Everyone with the secret derives the same key,
  so everyone in the room can read everyone else.
- **knock key** encrypts the little "hi, let me in" payload a newcomer sends.

If a room uses an optional **passphrase**, it's folded into the knock-key
derivation. That means knowing the link isn't enough to knock — you also need
the out-of-band passphrase. Stronger gate for the paranoid.

## Encrypting a message

AES-256-GCM, fresh 12-byte nonce per message. The clever bit is the
*associated data* (AAD): it isn't encrypted, but the tag covers it, so it can't
be tampered with. hisohiso binds each ciphertext to its context:

```
AAD = room_hash + msg_type + msg_id
```

So a ciphertext from one room can't be replayed into another, and a message
can't be passed off as a different type. The server stores and forwards the
whole `{nonce, ciphertext}` blob as an opaque string. It can't read it.

## The join handshake (the interesting part)

The problem: a newcomer needs a **participant token** (their proof they're
allowed to POST messages), but the token must be handed over *through the
server* without the server — or anyone watching the room's event stream — being
able to steal it.

The solution is an ephemeral ECDH key exchange layered on top, plus a one-time
"claim tag" so a sniffer can't race the real joiner. Walk through it:

```mermaid
sequenceDiagram
    autonumber
    participant N as Newcomer
    participant S as Server
    participant A as Approver (a member)

    N->>N: generate ephemeral ECDH P-256 keypair
    N->>S: POST /knock { encrypted "hi", knock_pubkey }
    Note right of N: keeps the private key in memory
    S-->>A: knock event (carries knock_pubkey)

    A->>A: generate own ephemeral keypair,<br/>ECDH with knock_pubkey → shared secret
    A->>A: HKDF → wrap key + claim tag
    A->>S: POST /approve { sha256(claim_tag) }
    S->>S: mint token (pending), store the claim-tag hash
    A->>A: AES-GCM encrypt { token, subscriber_jwt } with wrap key
    A->>S: POST /token { approver_pubkey, nonce, ciphertext }
    S-->>N: token event (only the lobby sees it)

    N->>N: ECDH(my privkey, approver_pubkey) → same shared secret
    N->>N: HKDF → same wrap key + claim tag, decrypt the bundle
    N->>S: POST /presence with X-Chat-Claim-Tag: claim_tag
    S->>S: sha256(tag) matches stored hash? activate token. else burn it.
    Note over N: now a full participant
```

Why each defense is there:

- **Ephemeral ECDH wrap** — the token bundle is encrypted to a key only the
  newcomer and approver can derive. The server relays an opaque blob. A passive
  subscriber to the room's events learns nothing.
- **The token isn't in the `approve` event.** That event is just a tombstone for
  the UI ("a join was approved"). The real secret travels as the wrapped
  `token` blob on a separate, lobby-only channel.
- **The claim tag** closes a race. Suppose someone sniffs the plaintext token
  anyway (they shouldn't be able to, but suppose). The token is minted
  *pending* and bound to `sha256(claim_tag)`. To activate it you must present
  the matching `claim_tag` — and that tag can only be derived from the ECDH
  shared secret, which the sniffer doesn't have. First wrong claim **burns the
  token**. The legitimate joiner re-knocks; the attacker is locked out.

## What an eavesdropper actually sees

Put yourself in the position of someone who has tapped the network or even
owns the server:

| They have | Can they read messages? | Why not |
| --- | --- | --- |
| The room hash | No | It's a one-way hash; no key derives from it |
| Every ciphertext in the room | No | AES-256-GCM, key never sent to server |
| The whole Mercure event stream | No | Same — only wrapped/encrypted blobs flow |
| A leaked subscriber JWT | They can *subscribe*, not *decrypt* | JWT gates delivery, not content; and it expires |
| The plaintext URL (the secret) | **Yes** | This is the one thing that matters — guard the link |

The takeaway for users is blunt: **the link is the room.** Anyone you give it to
can read everything. Anyone you don't, can't. If a link leaks, disband and make
a new room.

Next: [server.md](server.md) — exactly what the server stores and exposes.
