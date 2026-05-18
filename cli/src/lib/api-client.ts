export type CreateRoomResponse = {
  status: 'created' | 'exists';
  has_participants: boolean;
  participant_token?: string;
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

export const sendKnock = async (
  server: string,
  roomHash: string,
  msgId: string,
  encryptedPayload: string,
  knockPubkey: string
): Promise<MessageResponse> => {
  const res = await jsonPost(`${server}/api/rooms/${roomHash}/knock`, {
    msg_id: msgId,
    encrypted_payload: encryptedPayload,
    knock_pubkey: knockPubkey,
  });
  if (!res.ok) throw new Error(`sendKnock failed: ${res.status}`);
  return res.json() as Promise<MessageResponse>;
};

export const approveKnock = async (server: string, roomHash: string, token: string): Promise<ApproveResponse> => {
  const res = await jsonPost(`${server}/api/rooms/${roomHash}/approve`, {}, token);
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
  encryptedPayload: string
): Promise<MessageResponse> => {
  const res = await jsonPost(`${server}/api/rooms/${roomHash}/message`, {
    msg_id: msgId,
    encrypted_payload: encryptedPayload,
  }, token);
  if (!res.ok) throw new Error(`sendMessage failed: ${res.status}`);
  return res.json() as Promise<MessageResponse>;
};

export const sendPresence = async (server: string, roomHash: string, token: string): Promise<PresenceResponse> => {
  const res = await jsonPost(`${server}/api/rooms/${roomHash}/presence`, {}, token);
  if (!res.ok) throw new Error(`sendPresence failed: ${res.status}`);
  return res.json() as Promise<PresenceResponse>;
};

export const disbandRoom = async (server: string, roomHash: string, token: string): Promise<MessageResponse> => {
  const res = await jsonPost(`${server}/api/rooms/${roomHash}/disband`, {}, token);
  if (!res.ok) throw new Error(`disbandRoom failed: ${res.status}`);
  return res.json() as Promise<MessageResponse>;
};
