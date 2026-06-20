import { clearLocalRoomStorage } from '../src/lib/room-local-storage-cleanup.js';
import {
  getHandle,
  getLastKnockMessage,
  getRoomPassword,
  getSubscriberJwt,
  getToken,
  listRooms,
  setHandle,
  setLastKnockMessage,
  setRoomPassword,
  setSubscriberJwt,
  setToken,
  upsertRoom,
} from '../src/lib/storage.js';
import { setPresenceEnabled, isPresenceEnabled } from '../src/lib/presence.js';
import { setAutoApproveEnabled, isAutoApproveEnabled } from '../src/lib/auto-approve.js';
import { setPendingKnockCount, getPendingKnockCount } from '../src/lib/pending-knocks.js';

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  },
});

const roomHash = 'room-a';
const otherHash = 'room-b';

upsertRoom(roomHash, 'secret-a', 'alice');
upsertRoom(otherHash, 'secret-b', 'bob');
setToken(roomHash, 'token-a');
setSubscriberJwt(roomHash, 'jwt-a');
setHandle(roomHash, 'alice');
setRoomPassword(roomHash, 'key-a');
setLastKnockMessage(roomHash, 'open sesame');
setPresenceEnabled(roomHash, true);
setAutoApproveEnabled(roomHash, true);
setPendingKnockCount(roomHash, 2);
localStorage.setItem(`hisohiso.push.${roomHash}`, '1');
localStorage.setItem(`hisohiso.push_endpoint.${roomHash}`, 'https://push.example/endpoint-a');

setToken(otherHash, 'token-b');
setPresenceEnabled(otherHash, true);

clearLocalRoomStorage(roomHash);

assert(getToken(roomHash) === null, 'token should be cleared');
assert(getSubscriberJwt(roomHash) === null, 'subscriber jwt should be cleared');
assert(getHandle(roomHash) === null, 'handle should be cleared');
assert(getRoomPassword(roomHash) === null, 'room password should be cleared');
assert(getLastKnockMessage(roomHash) === null, 'last knock message should be cleared');
assert(!isPresenceEnabled(roomHash), 'presence opt-in should be cleared');
assert(!isAutoApproveEnabled(roomHash), 'auto-approve opt-in should be cleared');
assert(getPendingKnockCount(roomHash) === 0, 'pending knock count should be cleared');
assert(localStorage.getItem(`hisohiso.push.${roomHash}`) === null, 'push preference should be cleared');
assert(localStorage.getItem(`hisohiso.push_endpoint.${roomHash}`) === null, 'cached push endpoint should be cleared');
assert(!listRooms().some((room) => room.roomHash === roomHash), 'room list entry should be removed');

assert(getToken(otherHash) === 'token-b', 'other room token should be preserved');
assert(isPresenceEnabled(otherHash), 'other room presence should be preserved');
assert(listRooms().some((room) => room.roomHash === otherHash), 'other room list entry should be preserved');

console.log('room local cleanup OK');
