import { base64UrlDecode } from './crypto';
import {
  fetchVapidPublicKey,
  postPushForeground,
  postPushSubscribe,
  postPushTrigger,
  postPushUnsubscribe,
} from './room-session';
import {
  clearPushPreference,
  getPushEndpointPreference,
  roomPushFlagKey,
  setPushEndpointPreference,
} from './push-preference';

// Per-room web-push opt-in. The server only ever sends a content-less "tickle"
// (see server/push.php), so nothing here leaks message content. We reuse the
// existing root-scoped service worker (app/public/sw.js) that renders the
// generic notification.
//
// One browser has exactly one push subscription per origin, shared across every
// room. So "is this room subscribed?" can't be read off the browser
// subscription — we track it per-room in localStorage and register/unregister
// the shared endpoint against each room's server-side list independently.
// Disabling one room therefore never tears the endpoint down for the others.

export type PushStatus = 'unsupported' | 'denied' | 'on' | 'off';

export const pushSupported = (): boolean =>
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  typeof window !== 'undefined' &&
  'PushManager' in window &&
  'Notification' in window;

export const getPushStatus = (roomHash: string): PushStatus => {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return localStorage.getItem(roomPushFlagKey(roomHash)) === '1' ? 'on' : 'off';
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
  localStorage.setItem(roomPushFlagKey(roomHash), '1');
  setPushEndpointPreference(roomHash, sub.endpoint);
};

export const disablePush = async (roomHash: string, token: string): Promise<void> => {
  const fallbackEndpoint = getPushEndpointPreference(roomHash);
  clearPushPreference(roomHash);
  // Drop only this room's server registration; the shared browser subscription
  // stays alive for any other room that still wants notifications.
  let endpoint = fallbackEndpoint;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    endpoint = sub?.endpoint ?? endpoint;
  } catch {
    // If the service worker is unavailable during Forget, fall back to the
    // endpoint cached when push was enabled.
  }
  if (endpoint) {
    await postPushUnsubscribe(roomHash, token, endpoint).catch(() => {});
  }
};

// Notify the room's OTHER devices that a message was sent — never the sender's
// own device. We pass this device's push endpoint as exclude_endpoint so the
// server skips it; you don't get a notification for your own message. Best-
// effort and fire-and-forget: a missing subscription just means no exclusion.
//
// We only attach our endpoint when notifications are ON for THIS room. In that
// case the server already has it (push-subscribe registered it for this room),
// so nothing new is revealed and there's a real self-notification to suppress.
// For rooms we never enabled, our endpoint isn't in the room's list — there's
// nothing to exclude — so sending it would only leak it for a room the server
// didn't already associate it with. (The per-origin subscription is shared
// across rooms, so without this gate we'd leak it on every send.)
export const triggerRoomPush = async (roomHash: string, token: string): Promise<void> => {
  let ownEndpoint: string | undefined;
  if (getPushStatus(roomHash) === 'on') {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      ownEndpoint = sub?.endpoint;
    } catch {
      // Couldn't resolve our endpoint — fall through and notify everyone (the SW
      // visible-client check still suppresses our own foreground notification).
    }
  }
  await postPushTrigger(roomHash, token, 'normal', ownEndpoint).catch(() => {});
};


// Tell the server that this subscribed endpoint is currently viewing this room.
// notify_room() suppresses only this room+endpoint while the marker is fresh,
// so the live channel gets in-app updates without a duplicate OS banner. The
// endpoint is already registered server-side for this room when push is ON; we
// do not reveal it for rooms where notifications are disabled.
export const markPushForeground = async (
  roomHash: string,
  token: string,
  foreground: boolean,
  options: { keepalive?: boolean; force?: boolean } = {},
): Promise<void> => {
  if (!options.force && getPushStatus(roomHash) !== 'on') return;

  let endpoint = getPushEndpointPreference(roomHash);
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    endpoint = sub?.endpoint ?? endpoint;
  } catch {
    // Fall back to the endpoint cached when push was enabled.
  }
  if (!endpoint) return;

  await postPushForeground(roomHash, token, endpoint, foreground, options.keepalive).catch(() => {});
};
