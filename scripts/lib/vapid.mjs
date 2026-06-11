// Shared VAPID (Web Push application server) keypair minting, used by the
// gen-vapid CLI (production) and the dev launcher (auto-generated dev key).
// Keep the output shape identical to what server/push.php expects:
//   publicKey  — base64url of the 65-byte uncompressed P-256 point.
//   privateKey — base64( PEM of the PKCS#8 EC private key ), base64-wrapped so
//                its newlines survive a single-line env var.

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pemWrap = (der) =>
  `-----BEGIN PRIVATE KEY-----\n${b64(der).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;

export async function generateVapidKeypair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return {
    publicKey: b64url(rawPub),
    privateKey: b64(Buffer.from(pemWrap(pkcs8))),
  };
}
