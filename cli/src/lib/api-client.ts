export type CreateRoomResponse = {
  status: 'created' | 'exists';
  has_participants: boolean;
  participant_token?: string;
  subscriber_jwt?: string;
};

export type MessageResponse = {
  status: string;
};

export type PresenceResponse = {
  status: string;
  active_participants: number;
};

export type ApproveResponse = {
  new_participant_token: string;
  subscriber_jwt: string;
};

export type KnockResponse = {
  status: string;
  lobby_jwt: string;
};

const jsonPost = async (url: string, body: Record<string, unknown>, token?: string): Promise<Response> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['X-Chat-Token'] = token;
  }
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
};

export const createRoom = async (
  server: string,
  roomHash: string,
  opts?: { catchUp?: boolean }
): Promise<CreateRoomResponse> => {
  const body: Record<string, unknown> = { room_hash: roomHash };
  if (opts?.catchUp !== undefined) body.catch_up = opts.catchUp;
  const res = await jsonPost(`${server}/api/rooms`, body);
  if (!res.ok) throw new Error(`createRoom failed: ${res.status}`);
  return res.json() as Promise<CreateRoomResponse>;
};

export const checkRoom = async (server: string, roomHash: string): Promise<{ status: string; has_participants: boolean }> => {
  const res = await fetch(`${server}/api/rooms/${roomHash}`);
  if (!res.ok) throw new Error(`checkRoom failed: ${res.status}`);
  return res.json() as Promise<{ status: string; has_participants: boolean }>;
};

// Tri-state room existence check for reconciliation paths. Differs from
// checkRoom() in that it distinguishes "server says room is gone (404)"
// from "couldn't reach server (network / 5xx)". Callers that act on
// 'gone' (destroying local sessions) MUST NOT treat 'unknown' the same
// way — a transient 503 should not nuke a live agent.
export type RoomStatus = 'alive' | 'gone' | 'unknown';

export const roomStatus = async (server: string, roomHash: string): Promise<RoomStatus> => {
  try {
    const res = await fetch(`${server}/api/rooms/${roomHash}`);
    if (res.ok) return 'alive';
    if (res.status === 404) return 'gone';
    return 'unknown';
  } catch {
    return 'unknown';
  }
};

export const sendKnock = async (
  server: string,
  roomHash: string,
  msgId: string,
  encryptedPayload: string,
  knockPubkey: string
): Promise<KnockResponse> => {
  const res = await jsonPost(`${server}/api/rooms/${roomHash}/knock`, {
    msg_id: msgId,
    encrypted_payload: encryptedPayload,
    knock_pubkey: knockPubkey,
  });
  if (!res.ok) throw new Error(`sendKnock failed: ${res.status}`);
  return res.json() as Promise<KnockResponse>;
};

export const approveKnock = async (
  server: string,
  roomHash: string,
  token: string,
  claimTagHash: string
): Promise<ApproveResponse> => {
  const res = await jsonPost(`${server}/api/rooms/${roomHash}/approve`, { claim_tag_hash: claimTagHash }, token);
  if (!res.ok) throw new Error(`approveKnock failed: ${res.status}`);
  return res.json() as Promise<ApproveResponse>;
};

export const sendWrappedToken = async (
  server: string,
  roomHash: string,
  approverToken: string,
  knockMsgId: string,
  wrapped: { approver_pubkey: string; nonce: string; ct: string }
): Promise<MessageResponse> => {
  const res = await jsonPost(`${server}/api/rooms/${roomHash}/token`, {
    knock_msg_id: knockMsgId,
    approver_pubkey: wrapped.approver_pubkey,
    nonce: wrapped.nonce,
    ct: wrapped.ct,
  }, approverToken);
  if (!res.ok) throw new Error(`sendWrappedToken failed: ${res.status}`);
  return res.json() as Promise<MessageResponse>;
};

export const sendMessage = async (
  server: string,
  roomHash: string,
  token: string,
  msgId: string,
  encryptedPayload: string,
  ephemeral = false
): Promise<MessageResponse> => {
  const res = await jsonPost(`${server}/api/rooms/${roomHash}/message`, {
    msg_id: msgId,
    encrypted_payload: encryptedPayload,
    // Ephemeral = a transient status signal: the server publishes it as a
    // `status` event and does NOT append it to the outbox, so it never persists
    // or replays on catch-up.
    ...(ephemeral ? { ephemeral: true } : {}),
  }, token);
  if (!res.ok) throw new Error(`sendMessage failed: ${res.status}`);
  return res.json() as Promise<MessageResponse>;
};

export const sendPresence = async (
  server: string,
  roomHash: string,
  token: string,
  claimTag?: string
): Promise<PresenceResponse> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Chat-Token': token,
  };
  // First /presence for a knocker-minted token must carry the claim tag the
  // approver committed to via /approve. Room creators (token from /api/rooms)
  // never need this; their participants row is active from the start.
  if (claimTag) {
    headers['X-Chat-Claim-Tag'] = claimTag;
  }
  const res = await fetch(`${server}/api/rooms/${roomHash}/presence`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`sendPresence failed: ${res.status}`);
  return res.json() as Promise<PresenceResponse>;
};

export const disbandRoom = async (server: string, roomHash: string, token: string): Promise<MessageResponse> => {
  const res = await jsonPost(`${server}/api/rooms/${roomHash}/disband`, {}, token);
  if (!res.ok) throw new Error(`disbandRoom failed: ${res.status}`);
  return res.json() as Promise<MessageResponse>;
};
