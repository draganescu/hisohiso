import { getToken } from './storage';
import { clearRoomMessages } from './db';
import { disablePush, getPushStatus } from './push';
import { clearLocalRoomStorage } from './room-local-storage-cleanup';

export type WipeLocalRoomOptions = {
  /**
   * Best-effort server-side unregister for content-free push notifications.
   * Forgetting from /rooms still has the participant token, so it can unregister
   * before dropping local credentials. Destroy/leave paths may already have an
   * invalid token by the time cleanup runs; failures are intentionally ignored.
   */
  unregisterPush?: boolean;
};

/**
 * Remove every room-scoped local artifact this browser knows about.
 *
 * This is the shared implementation for "forget this device", disband cleanup,
 * leave cleanup, and destroyed-room cleanup. Keep new per-room localStorage /
 * IndexedDB flags here so /rooms and /room cannot drift.
 */
export const wipeLocalRoomArtifacts = async (
  roomHash: string,
  options: WipeLocalRoomOptions = {}
): Promise<void> => {
  const token = getToken(roomHash);

  if (options.unregisterPush && token && getPushStatus(roomHash) === 'on') {
    await disablePush(roomHash, token).catch(() => {
      // Local forget must succeed even if the browser/server refuses to
      // unregister the push endpoint. The local preference is cleared below.
    });
  }

  clearLocalRoomStorage(roomHash);
  await clearRoomMessages(roomHash);
};
