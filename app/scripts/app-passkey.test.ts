import {
  buildPasskeyCreateOptions,
  buildPasskeyGetOptions,
  PASSKEY_STORAGE_KEY,
  type StoredPasskeyCredential,
} from '../src/lib/app-passkey.js';

const assertEqual = (actual: unknown, expected: unknown, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
};

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const challenge = new Uint8Array([1, 2, 3, 4]);
const credential: StoredPasskeyCredential = {
  id: 'cred-id',
  rawId: 'AQIDBA',
  createdAt: 1710000000,
};

assertEqual(
  PASSKEY_STORAGE_KEY,
  'hisohiso.passkey',
  'uses a single global passkey storage key (not per room)'
);

const createOptions = buildPasskeyCreateOptions({
  challenge,
  label: 'Andrei',
});

assertEqual(createOptions.publicKey.challenge, challenge, 'create options use the supplied challenge');
assertEqual(createOptions.publicKey.rp.name, 'Hisohiso', 'create options set the relying party name');
assertEqual(createOptions.publicKey.user.name, 'Andrei', 'create options use the supplied label as user name');
assertEqual(createOptions.publicKey.authenticatorSelection?.userVerification, 'required', 'create requires device verification');
assertEqual(createOptions.publicKey.attestation, 'none', 'create avoids attestation collection');
assert(
  createOptions.publicKey.pubKeyCredParams.some((param) => param.alg === -7),
  'create options allow ES256 credentials'
);

const defaultLabelOptions = buildPasskeyCreateOptions({ challenge });
assertEqual(
  defaultLabelOptions.publicKey.user.name,
  'Hisohiso app lock',
  'create options fall back to a generic app-lock label'
);

const getOptions = buildPasskeyGetOptions({
  challenge,
  credential,
});

assertEqual(getOptions.publicKey.challenge, challenge, 'get options use the supplied challenge');
assertEqual(getOptions.publicKey.userVerification, 'required', 'get requires device verification');
assertEqual(getOptions.publicKey.allowCredentials?.[0]?.type, 'public-key', 'get constrains to the enrolled credential');
assertEqual(
  new Uint8Array(getOptions.publicKey.allowCredentials?.[0]?.id as ArrayBuffer)[0],
  1,
  'get decodes the stored raw credential id'
);

console.log('app-passkey behavior ok');
