export const roomPushFlagKey = (roomHash: string): string => `hisohiso.push.${roomHash}`;
const roomPushEndpointKey = (roomHash: string): string => `hisohiso.push_endpoint.${roomHash}`;

export const setPushEndpointPreference = (roomHash: string, endpoint: string): void => {
  try {
    localStorage.setItem(roomPushEndpointKey(roomHash), endpoint);
  } catch {
    // ignore: endpoint caching is best-effort fallback for later unregister.
  }
};

export const getPushEndpointPreference = (roomHash: string): string | null => {
  try {
    return localStorage.getItem(roomPushEndpointKey(roomHash));
  } catch {
    return null;
  }
};

export const clearPushPreference = (roomHash: string): void => {
  try {
    localStorage.removeItem(roomPushFlagKey(roomHash));
    localStorage.removeItem(roomPushEndpointKey(roomHash));
  } catch {
    // ignore: local cleanup should be best-effort and never block forgetting.
  }
};
