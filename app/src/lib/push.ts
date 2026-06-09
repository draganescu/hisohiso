import { base64UrlDecode } from './crypto';
import { getToken, listRooms } from './storage';
import { fetchVapidPublicKey, postPushSubscribe, postPushUnsubscribe } from './room-session';

// App-level web-push opt-in. A browser has exactly one push subscription per
// origin and one notification permission — both are app-wide, not per-room — so
// this is a single device-level switch (it lives on the channels home, next to
// the app lock), NOT a per-room toggle.
//
// Delivery is still per-room on the server (a push to room X only reaches
// devices registered for X — see server/push.php), because the privacy model
// gives a device a separate participant token per room and no global identity.
// So "on" registers this device's shared endpoint against every room we hold a
// token for; opening a room later lazily registers it too. "off" unregisters
// everywhere and unsubscribes the browser, which genuinely stops delivery (the
// OS permission can't be revoked from script, but no pushes arrive).

export type PushStatus = 'unsupported' | 'denied' | 'on' | 'off';

export const pushSupported = (): boolean =>
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  typeof window !== 'undefined' &&
  'PushManager' in window &&
  'Notification' in window;

// Notifications are "on" when permission is granted AND a browser subscription
// exists for this origin (shared across every room).
export const getPushStatus = async (): Promise<PushStatus> => {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'on' : 'off';
};

const roomsWithTokens = (): Array<{ hash: string; token: string }> =>
  listRooms()
    .map((r) => ({ hash: r.roomHash, token: getToken(r.roomHash) }))
    .filter((r): r is { hash: string; token: string } => typeof r.token === 'string' && r.token !== '');

const getVapidKey = async (): Promise<Uint8Array> => {
  const res = await fetchVapidPublicKey();
  if (!res.ok) throw new Error('Notifications are not configured on the server.');
  const { key } = (await res.json()) as { key: string };
  return base64UrlDecode(key);
};

export const enablePush = async (): Promise<void> => {
  if (!pushSupported()) throw new Error('Notifications are not supported on this device.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // Cast mirrors app/src/lib/crypto.ts: BufferSource is typed
        // ArrayBuffer-backed but a Uint8Array is ArrayBufferLike here.
        applicationServerKey: (await getVapidKey()) as BufferSource,
      });
    } catch (err) {
      // The browser refused its push service — surface the real reason instead
      // of failing silently (e.g. Safari rejecting push on a non-HTTPS origin).
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new Error(`Your browser refused to register for push (${reason}).`);
    }
  }

  // Register this device for every room we can authenticate to. Best-effort per
  // room — a since-disbanded room (404) shouldn't block the rest.
  const subscription = sub.toJSON();
  await Promise.all(roomsWithTokens().map(({ hash, token }) =>
    postPushSubscribe(hash, token, subscription).catch(() => {})));
};

export const disablePush = async (): Promise<void> => {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;

  // Drop the endpoint's registration from every room, then unsubscribe the
  // browser so the push service stops delivering. Order matters: unregister
  // while we still hold the endpoint string.
  const { endpoint } = sub;
  await Promise.all(roomsWithTokens().map(({ hash, token }) =>
    postPushUnsubscribe(hash, token, endpoint).catch(() => {})));
  await sub.unsubscribe().catch(() => {});
};

// Lazily register the room you're viewing if app-level notifications are on.
// Covers rooms joined AFTER enabling — opening the room registers it. No-op
// when notifications are off or unsupported.
export const registerRoomForPush = async (roomHash: string, token: string): Promise<void> => {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await postPushSubscribe(roomHash, token, sub.toJSON()).catch(() => {});
};
