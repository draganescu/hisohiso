Hisohiso

A minimal, URL-capability, encrypted chat system.

No accounts. No cloud history. No tracking. No identity theater.

⸻

1. Core Principles
	1.	The URL is the capability.
	2.	Encryption happens in the client (PWA).
	3.	The server only routes unreadable data.
	4.	Messages are stored locally on one device only.
	5.	Rooms persist on the server until destroyed.
	6.	Anyone in the room can approve new members.
	7.	Anyone in the room can disband (destroy) the room.
	8.	If nobody is online, nobody can join.

⸻

2. Protocol Specification (v0.1)

2.1 Room Secret & Derivation

Client generates or receives via URL:
	•	room_secret (32 bytes, 256-bit random)

Client derives:
	•	room_hash = SHA-256("hisohiso.room_hash" || room_secret)
	•	k_msg = HKDF(room_secret, "hisohiso.k_msg")

Server only ever sees room_hash.

⸻

2.2 Encryption Model

All chat payloads are encrypted client-side using AES-256-GCM.

Per message:
	•	12-byte nonce (unique per message)
	•	AAD: room_hash || msg_type || msg_id

Wire format:

{
  "v": 0,
  "alg": "A256GCM",
  "nonce": "<b64url>",
  "aad": "<b64url>",
  "ct": "<b64url>"
}

Server never decrypts.

⸻

2.3 Server Durable State

Persisted (e.g. SQLite):
	•	room_hash
	•	created_at
	•	last_activity_at
	•	participant_token_hashes

Ephemeral (memory only):
	•	Active participant connections
	•	Active lobby connections

Server stores no plaintext messages.

⸻

2.4 Participant Tokens
	•	32-byte random capability
	•	Server stores SHA-256(token)
	•	Token required to publish chat or approve/destroy

⸻

2.5 Room Lifecycle

Creation
	•	First client to connect to unknown room_hash becomes participant automatically.
	•	Server mints first participant_token.

Join (Knock)
	1.	Client connects without token → lobby state.
	2.	Client sends knock.
	3.	Online participants receive notification.
	4.	Any participant can approve.
	5.	Server mints participant_token.
	6.	Client upgrades to participant.

If no participants are online → no approval possible.

Destroy (Disband)
	•	Any participant sends destroy.
	•	Server deletes room and tokens.
	•	All connections terminated.
	•	Irreversible.

⸻

2.6 Message Types

Transport-agnostic JSON envelope:

{
  "v": 0,
  "type": "chat|knock|approve|reject|destroy|presence",
  "room_hash": "...",
  "from": "session_id",
  "ts": 0,
  "body": {}
}

Chat bodies are encrypted.

⸻

2.7 Storage Rules
	•	Server: no message persistence.
	•	Client: messages stored in IndexedDB.
	•	No multi-device sync.
	•	Clearing storage deletes chat history.

⸻

3. Transport Profiles

Two equivalent implementations:

A) WebSockets

Single persistent connection.
Full duplex messaging.

B) SSE + HTTP POST (Mercure-style)
	•	SSE for receiving events.
	•	HTTPS POST for sending actions.

Both conform to the same protocol.

⸻

4. UX Specification

Design tone: Signal-minimal.

No onboarding.
No identity setup.
No animations.
No fluff.

⸻

4.1 First Open (Creator)

State:
	•	User is first participant.

UI:
	•	Empty chat view.
	•	Subtle banner: “Messages stay on this device only.”

Actions:
	•	Share link
	•	Show QR code
	•	Disband room

QR modal:
	•	Large QR
	•	“Scan to join this room”
	•	“Losing this link means losing access.”

QR generation is fully local.

⸻

4.2 Join (Someone Online)

Screen:

Title: “Join room”
Optional message field
Primary: “Request to join”

After sending:
“Waiting for approval…”

On participant side:

“Someone wants to join”
[ Reject ] [ Approve ]

On approval → immediate transition to chat.

⸻

4.3 Join (Nobody Online)

Screen:

Title: “Room inactive”

“No one is currently in this room.
Ask someone inside to open it so they can approve you.”

Actions:
	•	Copy link
	•	Show QR

No fake waiting state.

⸻

4.4 Chat Screen
	•	Clean message bubbles
	•	No avatars
	•	No read receipts
	•	No typing indicators (v0)
	•	Timestamps on tap

Long-press:
	•	Delete (local)
	•	Copy
	•	Reply (optional)

Text-only input.

⸻

4.5 Disband Room

Modal:

“Disband this room?”
“This removes the room from the server.
Everyone will be disconnected.
It cannot be undone.”

[ Cancel ] [ Disband ]

Calm tone.

⸻

5. Landing Page

⸻

Hero

Fuck your bubble color.

Just chat.
No accounts. No tracking. No feeds. No blue vs green.

[ Start a room ]

⸻

It’s just a room.

You open a link.
You share it.
People knock.
You approve.
You talk.

Anyone can disband the room.

No profiles.
No phone numbers.
No cloud archive.
No algorithm.

⸻

Everyone same color.

Messaging turned into identity.

Blue vs green.
Verified vs unverified.
Real name vs username.

We don’t care.

Here, everyone is just text in the same room.

⸻

Private by design.

Messages are encrypted in your browser.
The server only routes unreadable data.
Messages live on your device.

Lose the link, lose the room.

⸻

Not a platform.

Not social media.
Not enterprise chat.
Not productivity software.

Just a shared space for people who already know each other.

⸻

Open.

The protocol is simple.
Run your own server.
Add features if you want.
Charge for them if you want.

Or just use it.

⸻

End

Minimal protocol.
Local storage.
No accounts.
