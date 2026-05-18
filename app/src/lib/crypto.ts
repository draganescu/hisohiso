const encoder = new TextEncoder();

export const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

export const base64UrlEncode = (bytes: Uint8Array): string => {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

export const base64UrlDecode = (input: string): Uint8Array => {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

export const bufferToHex = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bufferToHex(digest);
};

export const generateRoomSecret = (): string => {
  return base64UrlEncode(randomBytes(32));
};

export const deriveRoomHash = async (roomSecret: string): Promise<string> => {
  const prefix = encoder.encode('hisohiso.room_hash');
  const secretBytes = base64UrlDecode(roomSecret);
  const combined = new Uint8Array(prefix.length + secretBytes.length);
  combined.set(prefix, 0);
  combined.set(secretBytes, prefix.length);
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return bufferToHex(digest);
};

export const deriveMessageKey = async (roomSecret: string, password: string): Promise<CryptoKey> => {
  const prefix = encoder.encode('hisohiso.k_msg');
  const secretBytes = base64UrlDecode(roomSecret);
  const passwordBytes = encoder.encode(password);
  const combined = new Uint8Array(prefix.length + secretBytes.length + passwordBytes.length);
  combined.set(prefix, 0);
  combined.set(secretBytes, prefix.length);
  combined.set(passwordBytes, prefix.length + secretBytes.length);
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};

export const deriveKnockKey = async (roomSecret: string, password: string): Promise<CryptoKey> => {
  const prefix = encoder.encode('hisohiso.k_knock');
  const secretBytes = base64UrlDecode(roomSecret);
  const passwordBytes = encoder.encode(password);
  const combined = new Uint8Array(prefix.length + secretBytes.length + passwordBytes.length);
  combined.set(prefix, 0);
  combined.set(secretBytes, prefix.length);
  combined.set(passwordBytes, prefix.length + secretBytes.length);
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};

export type EncryptedPayload = {
  v: 0;
  alg: 'A256GCM';
  nonce: string;
  aad: string;
  ct: string;
};

const buildAadBytes = (roomHash: string, msgType: string, msgId: string): Uint8Array => {
  return encoder.encode(`${roomHash}${msgType}${msgId}`);
};

export const encryptText = async (
  key: CryptoKey,
  roomHash: string,
  msgType: string,
  msgId: string,
  plaintext: string
): Promise<EncryptedPayload> => {
  const nonce = randomBytes(12);
  const aadBytes = buildAadBytes(roomHash, msgType, msgId);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aadBytes },
    key,
    encoder.encode(plaintext)
  );
  return {
    v: 0,
    alg: 'A256GCM',
    nonce: base64UrlEncode(nonce),
    aad: base64UrlEncode(aadBytes),
    ct: base64UrlEncode(new Uint8Array(ciphertext))
  };
};

export const decryptText = async (
  key: CryptoKey,
  roomHash: string,
  msgType: string,
  msgId: string,
  payload: EncryptedPayload
): Promise<string> => {
  const nonce = base64UrlDecode(payload.nonce);
  const aadBytes = buildAadBytes(roomHash, msgType, msgId);
  const ciphertext = base64UrlDecode(payload.ct);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aadBytes },
    key,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
};

// --- Token wrap: ephemeral ECDH P-256 → HKDF-SHA256 → AES-256-GCM ---
// See cli/src/lib/crypto.ts for the matching helpers; both sides must agree
// byte-for-byte on curve, KDF info, and AES mode.
//
// The wrap delivers a freshly-minted participant_token from the approver to
// the knocker without broadcasting it. Alongside the wrap, both sides derive
// a "claim tag" — an HMAC over the knock's msg_id keyed by a second HKDF
// expansion of the same shared secret. The approver commits sha256(tag) on
// /approve; the knocker reveals the tag on first /presence. A sniffer who
// somehow obtains the plaintext token but not one of the ephemeral private
// keys cannot derive the tag and so cannot claim the token — and any wrong
// claim burns the row, so they cannot silently squat on it either.

const HKDF_INFO_TOKEN_WRAP = encoder.encode('hisohiso.token_wrap');
const HKDF_INFO_CLAIM_TAG = encoder.encode('hisohiso.claim_tag_v1');

export type EphemeralKeyPair = {
  publicKey: string;
  privateKey: CryptoKey;
};

export type WrappedToken = {
  approver_pubkey: string;
  nonce: string;
  ct: string;
};

export type ApproveBinding = {
  approverPubkey: string;
  claimTagHash: string;
  wrap: (bundle: string) => Promise<WrappedToken>;
};

export const generateEphemeralKeyPair = async (): Promise<EphemeralKeyPair> => {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  return {
    publicKey: base64UrlEncode(new Uint8Array(spki)),
    privateKey: pair.privateKey,
  };
};

const importPubKey = async (b64: string): Promise<CryptoKey> => {
  const bytes = base64UrlDecode(b64);
  return crypto.subtle.importKey(
    'spki',
    bytes as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
};

const deriveSharedKeys = async (
  privateKey: CryptoKey,
  peerPubB64: string
): Promise<{ wrapKey: CryptoKey; bindKey: CryptoKey }> => {
  const peer = await importPubKey(peerPubB64);
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peer },
    privateKey,
    256
  );
  const ikm = await crypto.subtle.importKey('raw', sharedBits, { name: 'HKDF' }, false, ['deriveKey']);
  const wrapKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0) as BufferSource,
      info: HKDF_INFO_TOKEN_WRAP as BufferSource,
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const bindKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0) as BufferSource,
      info: HKDF_INFO_CLAIM_TAG as BufferSource,
    },
    ikm,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return { wrapKey, bindKey };
};

const computeClaimTag = async (bindKey: CryptoKey, knockMsgId: string): Promise<string> => {
  const sig = await crypto.subtle.sign('HMAC', bindKey, encoder.encode(knockMsgId));
  return base64UrlEncode(new Uint8Array(sig));
};

// Approver-side: generate the ephemeral wrap keypair up front, derive both the
// wrap key (for /token) and the claim tag (committed to /approve as a hash).
// The returned `wrap` closure reuses the same ephemeral so /approve and /token
// stay consistent. Call order must be: beginApprove → POST /approve with
// claimTagHash → wrap(bundle) → POST /token.
export const beginApprove = async (
  knockerPubB64: string,
  knockMsgId: string
): Promise<ApproveBinding> => {
  const ephemeral = await generateEphemeralKeyPair();
  const { wrapKey, bindKey } = await deriveSharedKeys(ephemeral.privateKey, knockerPubB64);
  const claimTag = await computeClaimTag(bindKey, knockMsgId);
  const claimTagHash = await sha256Hex(claimTag);
  return {
    approverPubkey: ephemeral.publicKey,
    claimTagHash,
    wrap: async (bundle: string): Promise<WrappedToken> => {
      const nonce = randomBytes(12);
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource },
        wrapKey,
        encoder.encode(bundle)
      );
      return {
        approver_pubkey: ephemeral.publicKey,
        nonce: base64UrlEncode(nonce),
        ct: base64UrlEncode(new Uint8Array(ct)),
      };
    },
  };
};

// Knocker-side: decrypt the wrapped bundle AND derive the claim tag in one go
// (same ECDH, two HKDF expansions). Returns both so the caller can stash the
// tag and send it as X-Chat-Claim-Tag on first /presence.
export const unwrapAndDeriveClaim = async (
  knockerPriv: CryptoKey,
  approverPubB64: string,
  nonceB64: string,
  ctB64: string,
  knockMsgId: string
): Promise<{ plaintext: string; claimTag: string }> => {
  const { wrapKey, bindKey } = await deriveSharedKeys(knockerPriv, approverPubB64);
  const nonce = base64UrlDecode(nonceB64);
  const ct = base64UrlDecode(ctB64);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    wrapKey,
    ct as BufferSource
  );
  const claimTag = await computeClaimTag(bindKey, knockMsgId);
  return {
    plaintext: new TextDecoder().decode(plaintext),
    claimTag,
  };
};
