import {
  deriveRoomHash,
  deriveMessageKey,
  deriveKnockKey,
  encryptText,
  decryptText,
  generateEphemeralKeyPair,
  beginApprove,
  unwrapAndDeriveClaim,
  randomBytes,
  base64UrlEncode,
  sha256Hex,
  type EncryptedPayload,
  type EphemeralKeyPair,
} from './crypto.js';
import * as api from './api-client.js';
import { subscribeToRoom, type RoomEvent, type SSESubscription } from './sse-client.js';

// A headless "virtual participant" composed from the existing crypto /
// api-client / sse-client libs — no new protocol or crypto code. It plays
// either side of a room: the creator (TestClient.createRoom) or a joiner that
// knocks its way in (TestClient.joinRoom + knockAndAwaitApproval, the joiner
// half of wrap.ts's onKnock). Used by the headless test loop and Playwright
// fixtures to round-trip encrypted messages over the real relay.

const DEFAULT_NEXT_MESSAGE_TIMEOUT_MS = 30_000;
// Bound the knock→wrapped-token wait. knock/token are live-only events (never
// persisted/replayed on catch-up), so a missed token would otherwise hang the
// joiner forever; this converts that into a loud nonzero exit the trap teardown
// can clean up. Mirrors nextMessage()'s bounded wait.
const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

// Pull the room secret out of a join URL. Mirrors the PWA's extraction
// (RoomController.tsx) — the secret rides in the hash, e.g.
// `${server}/room#${secret}`. A bare secret (no scheme/hash) is accepted too
// so callers can pass either.
const extractSecret = (url: string): string => {
  const hashIdx = url.indexOf('#');
  // No '#' → already a bare secret. Otherwise take everything after it, minus a
  // leading slash (`/room#/secret`).
  return hashIdx === -1 ? url : url.slice(hashIdx + 1).replace(/^\/?/, '');
};

export class TestClient {
  private readonly server: string;
  private readonly roomSecret: string;
  private readonly roomHash: string;
  private readonly code: string;
  private readonly messageKey: CryptoKey;
  private token: string;
  private subscriberJwt: string;
  // Set only on the knocker side once approved: the claim tag must ride
  // X-Chat-Claim-Tag on the first /presence to activate the participant row.
  private claimTag?: string;

  private sse: SSESubscription | null = null;
  private ownTokenHash = '';
  // Creator side only: auto-approve incoming knocks (the approver half of
  // wrap.ts's onKnock). Knockers leave this off — they claim a token instead.
  private approveKnocks = false;
  private knockKey: CryptoKey | null = null;
  // msg_ids of knocks already approved, so a replayed knock isn't double-wrapped.
  private readonly approvedKnocks = new Set<string>();
  // Inbound chat decrypted off the SSE stream, queued FIFO. msg_id dedup
  // mirrors wrap.ts: the server can replay captured ciphertexts and catch-up
  // can re-deliver historical messages.
  private readonly inbox: Array<{ text: string; from?: string }> = [];
  private readonly seenMsgIds = new Set<string>();
  // A pending nextMessage() waiter, resolved as soon as a chat lands.
  private waiter: ((msg: { text: string; from?: string }) => void) | null = null;

  private constructor(opts: {
    server: string;
    roomSecret: string;
    roomHash: string;
    code: string;
    messageKey: CryptoKey;
    token: string;
    subscriberJwt: string;
  }) {
    this.server = opts.server;
    this.roomSecret = opts.roomSecret;
    this.roomHash = opts.roomHash;
    this.code = opts.code;
    this.messageKey = opts.messageKey;
    this.token = opts.token;
    this.subscriberJwt = opts.subscriberJwt;
  }

  // Creator side: mint a fresh room and become its first participant. The
  // returned client's `joinUrl` (server/room#secret) and `code` are what a
  // joiner needs to knock in.
  static async createRoom(server: string): Promise<TestClient> {
    const roomSecret = base64UrlEncode(randomBytes(32));
    const roomHash = await deriveRoomHash(roomSecret);
    // Pairing code doubles as the k_msg/k_knock password — a fixed test value
    // keeps the loop deterministic; the joiner is handed it via joinRoom.
    const code = base64UrlEncode(randomBytes(6));
    const created = await api.createRoom(server, roomHash, { catchUp: true });
    if (!created.participant_token || !created.subscriber_jwt) {
      throw new Error('TestClient.createRoom: server returned no participant token / subscriber JWT');
    }
    const messageKey = await deriveMessageKey(roomSecret, code);
    const client = new TestClient({
      server,
      roomSecret,
      roomHash,
      code,
      messageKey,
      token: created.participant_token,
      subscriberJwt: created.subscriber_jwt,
    });
    // The creator is the approver: it auto-admits any knock that decrypts under
    // k_knock (proving the joiner has the pairing code) — the headless analogue
    // of wrap.ts's onKnock auto-approve.
    client.approveKnocks = true;
    client.knockKey = await deriveKnockKey(roomSecret, code);
    await client.startSubscription();
    return client;
  }

  // Joiner side: prepare to knock into an existing room. Does NOT knock yet —
  // call knockAndAwaitApproval() once the creator is listening. `url` carries
  // the room secret in its hash; `code` is the pairing code (defaults to '' to
  // match the empty-password room path).
  static async joinRoom(server: string, url: string, code = ''): Promise<TestClient> {
    const roomSecret = extractSecret(url);
    const roomHash = await deriveRoomHash(roomSecret);
    // Ensure the room exists on the server and obtain a participant slot the
    // knock can authenticate against (the creator may have made it first).
    await api.createRoom(server, roomHash, { catchUp: true });
    const messageKey = await deriveMessageKey(roomSecret, code);
    return new TestClient({
      server,
      roomSecret,
      roomHash,
      code,
      // The joiner has no token/JWT until approved; filled in by
      // knockAndAwaitApproval().
      messageKey,
      token: '',
      subscriberJwt: '',
    });
  }

  // The joiner half of wrap.ts's onKnock: encrypt a knock under k_knock, send
  // it, and await the wrapped token the approver delivers over SSE. On success
  // the participant token + subscriber JWT are claimed and chat subscription
  // begins.
  async knockAndAwaitApproval(knockMessage: string, opts?: { timeoutMs?: number }): Promise<void> {
    const knockKey = await deriveKnockKey(this.roomSecret, this.code);
    const ephemeral: EphemeralKeyPair = await generateEphemeralKeyPair();
    const knockMsgId = base64UrlEncode(randomBytes(12));
    const encrypted = await encryptText(knockKey, this.roomHash, 'knock', knockMsgId, knockMessage);
    // /knock mints the lobby JWT, so the knock must be sent before we can
    // subscribe to the lobby topic where the wrapped token fans out. The
    // approver can only reply after several round-trips (it sees the knock on
    // its members topic, then beginApprove → /approve → /token), so we have
    // time to attach below; the bounded timeout guards the case where it never
    // comes (token events are live-only and never replayed on catch-up).
    const knockRes = await api.sendKnock(
      this.server,
      this.roomHash,
      knockMsgId,
      JSON.stringify(encrypted),
      ephemeral.publicKey
    );

    // Subscribe with the lobby JWT and wait for the approver to wrap a token
    // addressed to this knock. First-token-wins by construction: we close the
    // lobby subscription as soon as the wrapped token unwraps cleanly. A bounded
    // timeout converts a never-delivered token into a loud nonzero exit (the
    // trap teardown then cleans up) instead of an indefinite hang.
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const bundle = await new Promise<{ token: string; subscriber_jwt: string }>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let lobbySse: SSESubscription | null = null;
      const settle = (fn: () => void) => {
        if (timer) { clearTimeout(timer); timer = null; }
        lobbySse?.close();
        fn();
      };
      timer = setTimeout(() => {
        settle(() => reject(new Error(`TestClient.knockAndAwaitApproval: not approved within ${timeoutMs}ms`)));
      }, timeoutMs);
      lobbySse = subscribeToRoom(this.server, this.roomHash, knockRes.lobby_jwt, {
        onToken: async (event: RoomEvent) => {
          // Only the token wrapped for THIS knock is unwrappable by our
          // ephemeral private key; others fail and are ignored.
          if (event.body?.knock_msg_id !== knockMsgId) return;
          const approverPubkey = event.body?.approver_pubkey;
          const nonce = event.body?.nonce;
          const ct = event.body?.ct;
          if (typeof approverPubkey !== 'string' || typeof nonce !== 'string' || typeof ct !== 'string') {
            return;
          }
          try {
            const { plaintext, claimTag } = await unwrapAndDeriveClaim(
              ephemeral.privateKey,
              approverPubkey,
              nonce,
              ct,
              knockMsgId
            );
            this.claimTag = claimTag;
            settle(() => resolve(JSON.parse(plaintext) as { token: string; subscriber_jwt: string }));
          } catch (err) {
            settle(() => reject(err));
          }
        },
      }, { scope: 'lobby' });
    });

    this.token = bundle.token;
    this.subscriberJwt = bundle.subscriber_jwt;
    // First /presence for a knocker-minted token must carry the claim tag the
    // approver committed to via /approve — that activates the participant row.
    await api.sendPresence(this.server, this.roomHash, this.token, this.claimTag);
    await this.startSubscription();
  }

  // Encrypt `text` under k_msg and post it to the room. Shape matches
  // room-bridge's encryptAndSend ({ text, handle }) so the PWA and CLI render
  // it identically.
  async send(text: string): Promise<void> {
    if (!this.token) throw new Error('TestClient.send: not yet a participant — knock first');
    const msgId = base64UrlEncode(randomBytes(12));
    const payload = JSON.stringify({ text, handle: 'hisohiso-test-client' });
    const encrypted = await encryptText(this.messageKey, this.roomHash, 'chat', msgId, payload);
    await api.sendMessage(this.server, this.roomHash, this.token, msgId, JSON.stringify(encrypted));
  }

  // Simulate tapping a block button: sends a block_response envelope shaped like
  // the phone's, so the daemon's handleControl routes it by `value`.
  async sendBlockResponse(blockId: string, value: string, type = 'buttons'): Promise<void> {
    if (!this.token) throw new Error('TestClient.sendBlockResponse: not yet a participant — knock first');
    const msgId = base64UrlEncode(randomBytes(12));
    const payload = JSON.stringify({
      text: `[${type}] ${value}`,
      handle: 'hisohiso-test-client',
      block_response: { block_id: blockId, type, value },
    });
    const encrypted = await encryptText(this.messageKey, this.roomHash, 'chat', msgId, payload);
    await api.sendMessage(this.server, this.roomHash, this.token, msgId, JSON.stringify(encrypted));
  }

  // Await the next inbound chat message (decrypted), FIFO. Resolves
  // immediately if one is already queued; otherwise waits up to timeoutMs.
  async nextMessage(opts?: { timeoutMs?: number }): Promise<{ text: string; from?: string }> {
    const queued = this.inbox.shift();
    if (queued) return queued;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_NEXT_MESSAGE_TIMEOUT_MS;
    return new Promise<{ text: string; from?: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`TestClient.nextMessage: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiter = (msg) => {
        clearTimeout(timer);
        this.waiter = null;
        resolve(msg);
      };
    });
  }

  async close(): Promise<void> {
    if (this.sse) {
      this.sse.close();
      this.sse = null;
    }
  }

  // Open the chat subscription with the participant subscriber JWT, decrypting
  // each inbound chat and either handing it to a waiting nextMessage() or
  // queueing it. Self-heals an expired JWT via refreshSubscriberJwt, mirroring
  // the daemon's refreshJwt wiring. Resolves only once the EventSource has
  // actually connected (onOpen) — knock/token events are live-only and never
  // replayed, so the approver must be provably subscribed before any joiner
  // knocks, else the knock publishes into the void.
  private async startSubscription(): Promise<void> {
    this.ownTokenHash = await sha256Hex(this.token);
    await new Promise<void>((resolve) => {
      this.sse = subscribeToRoom(
        this.server,
        this.roomHash,
        this.subscriberJwt,
        {
          onOpen: () => resolve(),
          onKnock: this.approveKnocks
            ? (event: RoomEvent) => { void this.handleKnock(event); }
            : undefined,
          onChat: async (event: RoomEvent) => {
            // Skip our own echoes.
            if (event.from === this.ownTokenHash) return;
            const msgId = (event.body?.msg_id as string) || '';
            if (msgId && this.seenMsgIds.has(msgId)) return;
            if (msgId) this.seenMsgIds.add(msgId);
            try {
              const raw = event.body?.encrypted_payload;
              const enc = typeof raw === 'string'
                ? JSON.parse(raw) as EncryptedPayload
                : raw as EncryptedPayload;
              const decrypted = await decryptText(this.messageKey, this.roomHash, 'chat', msgId, enc);
              const parsed = JSON.parse(decrypted) as { text: string; handle?: string };
              this.deliver({ text: parsed.text, from: parsed.handle });
            } catch {
              // A payload we can't decrypt (wrong key / non-chat envelope) is not
              // our concern — drop it silently like the bridge does.
            }
          },
        },
        {
          refreshJwt: async () => {
            try {
              const next = await api.refreshSubscriberJwt(this.server, this.roomHash, this.token);
              this.subscriberJwt = next;
              return next;
            } catch {
              return null;
            }
          },
        }
      );
    });
  }

  // Approver half of wrap.ts's onKnock: a knock that decrypts under k_knock
  // proves the joiner holds the pairing code, so auto-admit it — beginApprove
  // commits a claim-tag hash via /approve, then wrap the new participant token
  // + subscriber JWT back to the knocker over the room's token channel. Failures
  // are swallowed (a knock we can't decrypt isn't for us), mirroring the silent
  // rejection of the production gate.
  private async handleKnock(event: RoomEvent): Promise<void> {
    if (!this.knockKey) return;
    const knockPubkey = event.body?.knock_pubkey;
    const knockMsgId = event.body?.msg_id;
    const rawPayload = event.body?.encrypted_payload;
    if (typeof knockPubkey !== 'string' || typeof knockMsgId !== 'string' || !rawPayload) return;
    if (this.approvedKnocks.has(knockMsgId)) return;
    try {
      const enc = typeof rawPayload === 'string'
        ? JSON.parse(rawPayload) as EncryptedPayload
        : rawPayload as EncryptedPayload;
      // Decrypt-success is the pairing-code proof; the cleartext is the knock
      // message but we don't gate on a specific value here (the test loop owns
      // both sides — the relay's k_knock derivation is the security boundary).
      await decryptText(this.knockKey, this.roomHash, 'knock', knockMsgId, enc);
    } catch {
      return;
    }
    this.approvedKnocks.add(knockMsgId);
    const binding = await beginApprove(knockPubkey, knockMsgId);
    const approveRes = await api.approveKnock(this.server, this.roomHash, this.token, binding.claimTagHash);
    const wrapped = await binding.wrap(JSON.stringify({
      token: approveRes.new_participant_token,
      subscriber_jwt: approveRes.subscriber_jwt,
    }));
    await api.sendWrappedToken(this.server, this.roomHash, this.token, knockMsgId, wrapped);
  }

  // Hand a decrypted chat to a pending nextMessage() if one is waiting,
  // otherwise queue it.
  private deliver(msg: { text: string; from?: string }): void {
    if (this.waiter) {
      this.waiter(msg);
    } else {
      this.inbox.push(msg);
    }
  }

  // Join material a creator hands to a joiner (server/room#secret + code).
  get joinUrl(): string {
    return `${this.server}/room#${this.roomSecret}`;
  }

  get pairingCode(): string {
    return this.code;
  }
}
