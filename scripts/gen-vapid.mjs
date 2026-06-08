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
import { generateVapidKeypair } from './lib/vapid.mjs';

const subjectArg = process.argv[2];
const subject = subjectArg
  ? (subjectArg.includes('://') || subjectArg.startsWith('mailto:') ? subjectArg : `mailto:${subjectArg}`)
  : 'mailto:admin@example.com';

const { publicKey, privateKey } = await generateVapidKeypair();

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`VAPID_SUBJECT=${subject}`);
