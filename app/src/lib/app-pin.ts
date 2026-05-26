// PIN fallback for the app lock. Used on devices with no passkey/biometric, and
// as a backstop if a passkey prompt fails. The PIN is never stored raw — only a
// salted PBKDF2-SHA256 hash.

const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

const base64UrlEncode = (bytes: Uint8Array): string => {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlDecode = (input: string): Uint8Array => {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

export type PinRecord = { salt: string; hash: string };

const PBKDF2_ITERATIONS = 200_000;

export const hashPin = async (pin: string, saltB64?: string): Promise<PinRecord> => {
  const salt = saltB64 ? base64UrlDecode(saltB64) : randomBytes(16);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin) as BufferSource,
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return { salt: base64UrlEncode(salt), hash: base64UrlEncode(new Uint8Array(bits)) };
};

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export const verifyPin = async (pin: string, record: PinRecord): Promise<boolean> => {
  const computed = await hashPin(pin, record.salt);
  return constantTimeEqual(computed.hash, record.hash);
};
