#!/usr/bin/env bun
// Mint a VAPID (Web Push application server) keypair and print the three env
// vars the server reads (see server/push.php). Run once per deployment:
//
//   bun scripts/gen-vapid.mjs you@example.com  >> .env
//
// VAPID_PUBLIC_KEY  — base64url of the 65-byte uncompressed P-256 point; the
//                     browser uses it as applicationServerKey and the server
//                     sends it as the `k=` Authorization parameter.
// VAPID_PRIVATE_KEY — base64( PEM of the PKCS#8 EC private key ); base64-wrapped
//                     so its newlines survive a single-line env var.
// VAPID_SUBJECT     — mailto:/https: contact (spec-required). Pass an email or
//                     URL as the first arg; defaults to a mailto: you can edit.

const subjectArg = process.argv[2];
const subject = subjectArg
  ? (subjectArg.includes('://') || subjectArg.startsWith('mailto:') ? subjectArg : `mailto:${subjectArg}`)
  : 'mailto:admin@example.com';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pemWrap = (der) => {
  const body = b64(der).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
};

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));

const pem = pemWrap(pkcs8);

console.log(`VAPID_PUBLIC_KEY=${b64url(rawPub)}`);
console.log(`VAPID_PRIVATE_KEY=${b64(Buffer.from(pem))}`);
console.log(`VAPID_SUBJECT=${subject}`);
