// Pending-knock hint for the /rooms list.
//
// WHAT THIS IS:
//   A purely LOCAL, presentational hint that lets the /rooms cards show a small
//   "someone is waiting" badge on a room that currently has un-handled join
//   requests. It is written by RoomController when it receives a knock over the
//   EXISTING end-to-end Mercure channel (already decrypted on this device), and
//   read by RoomCard on the index page.
//
// PRIVACY / SECURITY CONTRACT (read before changing anything here):
//   - It stores ONLY a small integer count per opaque room hash. No knock note,
//     no pubkey, no identity, no message content — nothing that could fingerprint
//     a person or correlate across rooms. The knock note/pubkey stay inside
//     RoomController's ephemeral `knocks` state and never reach this store.
//   - It is LOCAL ONLY. Nothing is uploaded; the relay never learns it exists.
//     Mirrors the flat per-room localStorage helpers (token/handle/presence).
//   - It does NOT add any new server endpoint or message type. The count is a
//     by-product of an E2E knock event the client already received and decrypted.
//   - Cleared on forget/wipe so no hint survives leaving a room.
//
//   // TODO(server): truly app-wide / background knock delivery (a badge that
//   // lights up on /rooms while NO room screen is open) needs the relay or the
//   // service worker to wake on a knock and surface a content-free signal. That
//   // is server/SW work and is intentionally NOT implemented here — this store
//   // only reflects knocks the client decrypted while the room was open, and
//   // persists them so the hint survives navigating to /rooms. Do not fake the
//   // background path.

const pendingKnocksKey = (roomHash: string): string => `hisohiso.pending_knocks.${roomHash}`;

// Custom event name so listeners in the SAME tab/page get notified immediately
// (the native `storage` event only fires in OTHER tabs). RoomCard listens for
// both so it updates whether the change came from this page or another.
export const PENDING_KNOCKS_EVENT = 'hisohiso:pending-knocks';

const emitChange = (roomHash: string): void => {
  try {
    window.dispatchEvent(new CustomEvent(PENDING_KNOCKS_EVENT, { detail: { roomHash } }));
  } catch {
    // window/CustomEvent unavailable (SSR/tests): the write still landed in
    // storage; same-page listeners just won't get the synchronous nudge.
  }
};

export const getPendingKnockCount = (roomHash: string): number => {
  try {
    const raw = localStorage.getItem(pendingKnocksKey(roomHash));
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
};

export const setPendingKnockCount = (roomHash: string, count: number): void => {
  try {
    if (count > 0) {
      localStorage.setItem(pendingKnocksKey(roomHash), String(Math.floor(count)));
    } else {
      // Absence == zero, so clearing is a plain delete with no lingering state.
      localStorage.removeItem(pendingKnocksKey(roomHash));
    }
  } catch {
    // localStorage unavailable: the hint simply never appears. Never throws.
  }
  emitChange(roomHash);
};

// Drop a room's pending-knock hint entirely. Call from the room's Forget/wipe
// path so no hint survives removal from this device.
export const clearPendingKnocks = (roomHash: string): void => {
  setPendingKnockCount(roomHash, 0);
};
