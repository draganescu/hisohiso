import type { RoomEvent } from './room-contracts';

export type RoomTopicScope = 'members' | 'lobby';

export type RoomLookupResponse = {
  status: 'exists';
  has_participants: boolean;
  catch_up_enabled?: boolean;
};

export type OutboxMessage = {
  msg_id: string;
  ts: number;
  sender_hash: string | null;
  encrypted_payload: string;
};

export type ApiRequestOptions = {
  signal?: AbortSignal;
};

const jsonHeaders = { 'Content-Type': 'application/json' };

export const fetchRoomStatus = async (roomHash: string, options: ApiRequestOptions = {}): Promise<Response> => {
  return fetch(`/api/rooms/${roomHash}`, { signal: options.signal });
};

export const postPresence = async (
  roomHash: string,
  token: string,
  options: ApiRequestOptions = {},
): Promise<Response> => {
  return fetch(`/api/rooms/${roomHash}/presence`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'X-Chat-Token': token },
    signal: options.signal,
  });
};

export const refreshSubscriberToken = async (
  roomHash: string,
  token: string,
  options: ApiRequestOptions = {},
): Promise<Response> => {
  return fetch(`/api/rooms/${roomHash}/sub-token`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'X-Chat-Token': token },
    signal: options.signal,
  });
};

export const postEncryptedRoomMessage = async (
  roomHash: string,
  token: string,
  msgId: string,
  encryptedPayload: string,
): Promise<Response> => {
  return fetch(`/api/rooms/${roomHash}/message`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'X-Chat-Token': token },
    body: JSON.stringify({ msg_id: msgId, encrypted_payload: encryptedPayload }),
  });
};

export const fetchOutbox = async (
  roomHash: string,
  token: string,
  sinceTs: number,
): Promise<Response> => {
  return fetch(`/api/rooms/${roomHash}/outbox?since_ts=${sinceTs}`, {
    headers: { 'X-Chat-Token': token },
  });
};

export const postKnock = async (
  roomHash: string,
  msgId: string,
  encryptedPayload: string,
  knockPubkey: string,
): Promise<Response> => {
  return fetch(`/api/rooms/${roomHash}/knock`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ msg_id: msgId, encrypted_payload: encryptedPayload, knock_pubkey: knockPubkey }),
  });
};

export const postApprove = async (
  roomHash: string,
  token: string,
  claimTagHash: string,
): Promise<Response> => {
  return fetch(`/api/rooms/${roomHash}/approve`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'X-Chat-Token': token },
    body: JSON.stringify({ claim_tag_hash: claimTagHash }),
  });
};

export const postWrappedToken = async (
  roomHash: string,
  token: string,
  body: { knock_msg_id: string; approver_pubkey: string; nonce: string; ct: string },
): Promise<Response> => {
  return fetch(`/api/rooms/${roomHash}/token`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'X-Chat-Token': token },
    body: JSON.stringify(body),
  });
};

export const postReject = async (roomHash: string, token: string): Promise<Response> => {
  return fetch(`/api/rooms/${roomHash}/reject`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'X-Chat-Token': token },
  });
};

export const postDisband = async (roomHash: string, token: string): Promise<Response> => {
  return fetch(`/api/rooms/${roomHash}/disband`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'X-Chat-Token': token },
  });
};

export const postLeave = async (roomHash: string, token: string): Promise<Response> => {
  return fetch(`/api/rooms/${roomHash}/leave`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'X-Chat-Token': token },
  });
};

export const postRoomSettings = async (
  roomHash: string,
  token: string,
  catchUpEnabled: boolean,
): Promise<Response> => {
  return fetch(`/api/rooms/${roomHash}/settings`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'X-Chat-Token': token },
    body: JSON.stringify({ catch_up_enabled: catchUpEnabled }),
  });
};

// --- Web push (content-less notifications) ---

// Public: the VAPID application server key the browser needs to subscribe.
export const fetchVapidPublicKey = async (options: ApiRequestOptions = {}): Promise<Response> => {
  return fetch('/api/push/vapid-public-key', { signal: options.signal });
};

export const postPushSubscribe = async (
  roomHash: string,
  token: string,
  subscription: PushSubscriptionJSON,
): Promise<Response> => {
  return fetch(`/api/rooms/${roomHash}/push-subscribe`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'X-Chat-Token': token },
    body: JSON.stringify({ subscription }),
  });
};

export const postPushUnsubscribe = async (
  roomHash: string,
  token: string,
  endpoint: string,
): Promise<Response> => {
  return fetch(`/api/rooms/${roomHash}/push-unsubscribe`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'X-Chat-Token': token },
    body: JSON.stringify({ endpoint }),
  });
};

// Ping the room's other subscribed devices (content-less). The PWA calls this
// after sending a chat message so a backgrounded peer gets notified — mirrors
// what the CLI daemon does on an agent turn. The sender's own open tab is
// suppressed by the service worker's visible-client check.
export const postPushTrigger = async (
  roomHash: string,
  token: string,
  urgency: 'normal' | 'high' = 'normal',
): Promise<Response> => {
  return fetch(`/api/rooms/${roomHash}/push`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'X-Chat-Token': token },
    body: JSON.stringify({ urgency }),
  });
};

export const parseRoomEvent = (raw: string, expectedRoomHash: string): RoomEvent | null => {
  const payload = JSON.parse(raw) as RoomEvent;
  if (!payload || payload.room_hash !== expectedRoomHash) return null;
  return payload;
};
