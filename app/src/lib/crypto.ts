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

const HKDF_INFO_TOKEN_WRAP = encoder.encode('hisohiso.token_wrap');

export type EphemeralKeyPair = {
  publicKey: string;
  privateKey: CryptoKey;
};

export type WrappedToken = {
  approver_pubkey: string;
  nonce: string;
  ct: string;
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

const deriveWrapKey = async (privateKey: CryptoKey, peerPubB64: string): Promise<CryptoKey> => {
  const peer = await importPubKey(peerPubB64);
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peer },
    privateKey,
    256
  );
  const ikm = await crypto.subtle.importKey('raw', sharedBits, { name: 'HKDF' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
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
};

export const wrapToken = async (knockerPubB64: string, token: string): Promise<WrappedToken> => {
  const ephemeral = await generateEphemeralKeyPair();
  const wrapKey = await deriveWrapKey(ephemeral.privateKey, knockerPubB64);
  const nonce = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    wrapKey,
    encoder.encode(token)
  );
  return {
    approver_pubkey: ephemeral.publicKey,
    nonce: base64UrlEncode(nonce),
    ct: base64UrlEncode(new Uint8Array(ct)),
  };
};

export const unwrapToken = async (
  knockerPriv: CryptoKey,
  approverPubB64: string,
  nonceB64: string,
  ctB64: string
): Promise<string> => {
  const wrapKey = await deriveWrapKey(knockerPriv, approverPubB64);
  const nonce = base64UrlDecode(nonceB64);
  const ct = base64UrlDecode(ctB64);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    wrapKey,
    ct as BufferSource
  );
  return new TextDecoder().decode(plaintext);
};
