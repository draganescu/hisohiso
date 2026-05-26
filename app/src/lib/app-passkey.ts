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

export type StoredPasskeyCredential = {
  id: string;
  rawId: string;
  createdAt: number;
};

type CreateOptionsInput = {
  challenge: Uint8Array;
  label?: string;
};

type GetOptionsInput = {
  challenge: Uint8Array;
  credential: StoredPasskeyCredential;
};

// The app lock is a single GLOBAL setting, so the passkey credential is stored
// under one key, not per room.
export const PASSKEY_STORAGE_KEY = 'hisohiso.passkey';

export const isPasskeySupported = (): boolean => {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window && Boolean(navigator.credentials);
};

export const getStoredPasskeyCredential = (): StoredPasskeyCredential | null => {
  const raw = localStorage.getItem(PASSKEY_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredPasskeyCredential;
    if (typeof parsed.id === 'string' && typeof parsed.rawId === 'string') {
      return parsed;
    }
  } catch {
    // Ignore malformed local state and treat passkey unlock as unavailable.
  }
  return null;
};

export const setStoredPasskeyCredential = (credential: StoredPasskeyCredential): void => {
  localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(credential));
};

export const clearStoredPasskeyCredential = (): void => {
  localStorage.removeItem(PASSKEY_STORAGE_KEY);
};

export const buildPasskeyCreateOptions = ({
  challenge,
  label = 'Hisohiso app lock',
}: CreateOptionsInput): CredentialCreationOptions => {
  return {
    publicKey: {
      challenge: challenge as BufferSource,
      rp: { name: 'Hisohiso' },
      user: {
        id: randomBytes(16) as BufferSource,
        name: label,
        displayName: label,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
      timeout: 60000,
      attestation: 'none',
    },
  };
};

export const buildPasskeyGetOptions = ({
  challenge,
  credential,
}: GetOptionsInput): CredentialRequestOptions => {
  return {
    publicKey: {
      challenge: challenge as BufferSource,
      allowCredentials: [
        {
          type: 'public-key',
          id: base64UrlDecode(credential.rawId) as BufferSource,
        },
      ],
      userVerification: 'required',
      timeout: 60000,
    },
  };
};

export const enrollPasskey = async (label?: string): Promise<StoredPasskeyCredential> => {
  if (!isPasskeySupported()) {
    throw new Error('Passkeys are not available in this browser.');
  }
  const created = await navigator.credentials.create(
    buildPasskeyCreateOptions({ challenge: randomBytes(32), label })
  );
  if (!(created instanceof PublicKeyCredential) || !created.rawId) {
    throw new Error('Passkey enrollment did not return a public-key credential.');
  }
  const credential: StoredPasskeyCredential = {
    id: created.id,
    rawId: base64UrlEncode(new Uint8Array(created.rawId)),
    createdAt: Math.floor(Date.now() / 1000),
  };
  setStoredPasskeyCredential(credential);
  return credential;
};

export const verifyPasskey = async (credential: StoredPasskeyCredential): Promise<void> => {
  if (!isPasskeySupported()) {
    throw new Error('Passkeys are not available in this browser.');
  }
  const assertion = await navigator.credentials.get(
    buildPasskeyGetOptions({ challenge: randomBytes(32), credential })
  );
  if (!(assertion instanceof PublicKeyCredential)) {
    throw new Error('Passkey unlock was cancelled or did not return a credential.');
  }
};
