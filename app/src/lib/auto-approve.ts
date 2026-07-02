import { useCallback, useEffect, useState } from 'react';

// Auto-approve is a per-room, OPT-IN, off-by-default convenience that lets a
// member approve incoming knocks WITHOUT tapping "approve" each time.
//
// PRIVACY / SECURITY CONTRACT (read before changing anything here):
//   - It is purely a LOCAL UI preference. The flag never leaves the device, is
//     never uploaded, and the relay never learns it exists. Mirrors the
//     local-only per-room helpers at the top of storage.ts (token/handle/
//     room_password).
//   - It does NOT weaken the join handshake. A knock only auto-approves once the
//     joiner has cryptographically PROVEN possession of the room link + password:
//     the knock arrives encrypted under knockKey = deriveKnockKey(roomSecret,
//     roomPassword), so a SUCCESSFUL DECRYPT on the approver side already proves
//     the knocker holds both secrets. Auto-approve runs the SAME approve crypto
//     (beginApprove → /approve → wrap → /wrapped-token) the manual button runs;
//     it only removes the human tap, never a verification step.
//   - It introduces NO vouching / referrer / "who sent you" notion. There is no
//     contact graph and no cross-room correlation — it acts only on the knock's
//     own ephemeral pubkey + msgId, both per-pairing values.
//   - Off by default: absence of the stored flag means manual approval, the safe
//     default. Cleared on forget so no preference survives leaving a room.

const autoApproveKey = (roomHash: string): string => `hisohiso.autoapprove.${roomHash}`;

// Off by default: any room without an explicit stored '1' requires manual approval.
export const isAutoApproveEnabled = (roomHash: string): boolean => {
  try {
    return localStorage.getItem(autoApproveKey(roomHash)) === '1';
  } catch {
    return false;
  }
};

export const setAutoApproveEnabled = (roomHash: string, enabled: boolean): void => {
  try {
    if (enabled) {
      localStorage.setItem(autoApproveKey(roomHash), '1');
    } else {
      // Removing (rather than storing '0') keeps "off" indistinguishable from
      // "never set" — both mean manual approval — so forget/clear is a plain
      // delete with no lingering state to reason about.
      localStorage.removeItem(autoApproveKey(roomHash));
    }
  } catch {
    // localStorage unavailable (private-mode quirks): auto-approve simply stays
    // at its safe default of off. Never throws into the caller.
  }
};

// Drop a room's opt-in flag entirely. Call from the room's Forget/wipe path so
// no auto-approve preference survives removal from this device.
export const clearAutoApprove = (roomHash: string): void => {
  try {
    localStorage.removeItem(autoApproveKey(roomHash));
  } catch {
    // ignore
  }
};

// --- React hook ------------------------------------------------------------
//
// Follows a local-state-with-storage pattern: reads the
// persisted opt-in and exposes a setter that writes through to storage. The
// hook never talks to the server and never opens a socket.
export type UseRoomAutoApprove = {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  toggle: () => void;
};

export const useRoomAutoApprove = (roomHash: string): UseRoomAutoApprove => {
  const [enabled, setEnabledState] = useState<boolean>(() => isAutoApproveEnabled(roomHash));

  // Re-read the per-room flag whenever the room changes. RoomController is a
  // single never-remounted instance that swaps rooms in-place (hash-only swap),
  // so without this the opt-in from a PREVIOUS room would leak into the next —
  // breaking the off-by-default, per-room contract and silently auto-approving
  // knocks in a room that never opted in.
  useEffect(() => {
    setEnabledState(isAutoApproveEnabled(roomHash));
  }, [roomHash]);

  const setEnabled = useCallback(
    (next: boolean) => {
      setAutoApproveEnabled(roomHash, next);
      setEnabledState(next);
    },
    [roomHash]
  );

  const toggle = useCallback(() => {
    setEnabled(!isAutoApproveEnabled(roomHash));
  }, [roomHash, setEnabled]);

  return { enabled, setEnabled, toggle };
};
