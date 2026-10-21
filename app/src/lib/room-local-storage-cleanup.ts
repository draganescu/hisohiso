import {
  clearHandle,
  clearExpectedKnockMessage,
  clearLastKnockMessage,
  clearRoomPassword,
  clearRoomSetupDismissed,
  clearSubscriberJwt,
  clearToken,
  removeRoom,
} from './storage';
import { clearAutoApprove } from './auto-approve';
import { clearPendingKnocks } from './pending-knocks';
import { clearPushPreference } from './push-preference';

/**
 * Remove every synchronous room-scoped localStorage artifact this browser knows
 * about. Kept separate from IndexedDB / push unregistering so the forget
 * contract can be regression-tested in Node.
 */
export const clearLocalRoomStorage = (roomHash: string): void => {
  clearToken(roomHash);
  clearSubscriberJwt(roomHash);
  clearHandle(roomHash);
  clearRoomPassword(roomHash);
  clearExpectedKnockMessage(roomHash);
  clearLastKnockMessage(roomHash);
  clearRoomSetupDismissed(roomHash);
  clearAutoApprove(roomHash);
  clearPendingKnocks(roomHash);
  clearPushPreference(roomHash);
  removeRoom(roomHash);
};
