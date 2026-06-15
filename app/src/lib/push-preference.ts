export const roomPushFlagKey = (roomHash: string): string => `hisohiso.push.${roomHash}`;

export const clearPushPreference = (roomHash: string): void => {
  try {
    localStorage.removeItem(roomPushFlagKey(roomHash));
  } catch {
    // ignore: local cleanup should be best-effort and never block forgetting.
  }
};
