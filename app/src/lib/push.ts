import { base64UrlDecode } from './crypto';
import { fetchVapidPublicKey, postPushSubscribe, postPushUnsubscribe } from './room-session';

// Per-room web-push opt-in. The server only ever sends a content-less "tickle"
// (see server/push.php), so nothing here leaks agent content. We reuse the
// existing root-scoped service worker (app/public/sw.js) that renders the
// generic notification.
//
// One browser has exactly one push subscription per origin, shared across every
// room. So "is this room subscribed?" can't be read off the browser
// subscription — we track it per-room in localStorage and register/unregister
// the shared endpoint against each room's server-side list independently.
// Disabling one room therefore never tears the endpoint down for the others.

export type PushStatus = 'unsupported' | 'denied' | 'on' | 'off';

const roomFlagKey = (roomHash: string): string => `hisohiso.push.${roomHash}`;

export const pushSupported = (): boolean =>
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  typeof window !== 'undefined' &&
  'PushManager' in window &&
  'Notification' in window;

export const getPushStatus = (roomHash: string): PushStatus => {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return localStorage.getItem(roomFlagKey(roomHash)) === '1' ? 'on' : 'off';
};

// Ensure a browser PushSubscription exists for this origin, creating one against
// the server's VAPID key if needed. The same subscription is reused by every
// room.
const ensureSubscription = async (): Promise<PushSubscription> => {
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;

  const res = await fetchVapidPublicKey();
  if (!res.ok) {
    throw new Error('Notifications are not configured on the server.');
  }
  const { key } = (await res.json()) as { key: string };
  try {
    return await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // Cast mirrors app/src/lib/crypto.ts: the DOM lib types BufferSource as
      // ArrayBuffer-backed, but a Uint8Array is ArrayBufferLike under this config.
      applicationServerKey: base64UrlDecode(key) as BufferSource,
    });
  } catch (err) {
    // The browser refused to register with its push service. This is the most
    // common silent failure: it surfaces as a bare DOMException (e.g. "push
    // service not available", or Safari rejecting push over plain HTTP). Carry
    // the real reason out so the toggle can show why instead of doing nothing.
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    throw new Error(`Your browser refused to register for push (${reason}).`);
  }
};

export const enablePush = async (roomHash: string, token: string): Promise<void> => {
  if (!pushSupported()) throw new Error('Notifications are not supported on this device.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }

  const sub = await ensureSubscription();
  const res = await postPushSubscribe(roomHash, token, sub.toJSON());
  if (!res.ok) {
    throw new Error('Could not register this channel for notifications.');
  }
  localStorage.setItem(roomFlagKey(roomHash), '1');
};

export const disablePush = async (roomHash: string, token: string): Promise<void> => {
  localStorage.removeItem(roomFlagKey(roomHash));
  // Drop only this room's server registration; the shared browser subscription
  // stays alive for any other room that still wants notifications.
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await postPushUnsubscribe(roomHash, token, sub.endpoint).catch(() => {});
  }
};
