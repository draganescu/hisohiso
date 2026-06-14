import { useCallback, useEffect, useMemo, useState } from 'react';

// Presence in hisohiso is deliberately minimal and privacy-first.
//
// What it is NOT:
//   - It is NOT a server-side presence system. The relay only ever sees
//     ciphertext and opaque room hashes; it never learns who is online.
//   - It is NOT a read receipt. Nothing reports that you have seen a message.
//   - It does NOT broadcast your identity, mark, handle, or device id to
//     anyone — not the server, not other members.
//
// What it IS today: a purely LOCAL derivation of whether THIS device is
// currently live in a room, computed from the user's OWN connection status
// (the same `'idle' | 'connected' | 'error'` state the room screen already
// tracks for its Mercure EventSource). "Live" here means "my own socket is
// connected" — a self-reflection, never a claim about anyone else.
//
// The per-room opt-in flag below only governs whether the UI *surfaces* a live
// indicator at all. It is off by default, stored local-only, and never leaves
// the device. Even when on, the safe implementation still reveals nothing to
// the network — see the TODO(server) beacon stub at the bottom.

// Mirrors the room screen's own connection vocabulary (RoomController's
// `connection` state). Kept as a local literal union so this module stays
// self-contained and does not couple to a screen component.
export type OwnConnectionStatus = 'idle' | 'connected' | 'error';

// What the UI may show for the user's OWN presence in a room. This describes
// only the local device's relationship to the relay — never another person.
//   'live'         → my socket is connected; messages flow in real time.
//   'reconnecting' → my socket dropped and is retrying.
//   'connecting'   → first connect in progress, nothing established yet.
//   'off'          → presence is opted out for this room (the default).
export type PresenceState = 'off' | 'connecting' | 'live' | 'reconnecting';

// --- Local-only per-room opt-in -------------------------------------------
//
// Stored under its own namespaced key per room, mirroring the flat per-room
// helpers at the top of storage.ts (token/handle/room_password). Kept separate
// from the StoredRoom record so it is trivially backward-compatible: absence of
// the key means "not opted in" — the safe default — and nothing in the rooms
// list needs migrating. Local-only; never uploaded; cleared on forget.

const presenceOptInKey = (roomHash: string): string => `hisohiso.presence_optin.${roomHash}`;

// Off by default: any room without an explicit stored '1' is opted OUT.
export const isPresenceEnabled = (roomHash: string): boolean => {
  try {
    return localStorage.getItem(presenceOptInKey(roomHash)) === '1';
  } catch {
    return false;
  }
};

export const setPresenceEnabled = (roomHash: string, enabled: boolean): void => {
  try {
    if (enabled) {
      localStorage.setItem(presenceOptInKey(roomHash), '1');
    } else {
      // Removing (rather than storing '0') keeps "off" indistinguishable from
      // "never set" — both mean opted out — so there is no lingering state to
      // reason about and forget/clear is a plain delete.
      localStorage.removeItem(presenceOptInKey(roomHash));
    }
  } catch {
    // localStorage unavailable (private-mode quirks): presence simply stays at
    // its safe default of off. Never throws into the caller.
  }
};

// Drop a room's opt-in flag entirely. Call from the room's Forget path so no
// presence preference survives removal from this device.
export const clearPresence = (roomHash: string): void => {
  try {
    localStorage.removeItem(presenceOptInKey(roomHash));
  } catch {
    // ignore
  }
};

// --- Pure derivation -------------------------------------------------------
//
// The single source of truth for what presence to show, given the opt-in flag
// and the user's OWN connection status. Pure and side-effect free so it is easy
// to unit-test and reuse outside React. When opted out it is always 'off',
// regardless of connection — opt-out fully suppresses the signal.
export const derivePresenceState = (
  enabled: boolean,
  ownConnection: OwnConnectionStatus
): PresenceState => {
  if (!enabled) return 'off';
  switch (ownConnection) {
    case 'connected':
      return 'live';
    case 'error':
      return 'reconnecting';
    case 'idle':
    default:
      return 'connecting';
  }
};

// True only when the user has opted in AND their own socket is connected.
// Convenience for call sites that just want a boolean "am I live here".
export const isOwnLive = (enabled: boolean, ownConnection: OwnConnectionStatus): boolean =>
  derivePresenceState(enabled, ownConnection) === 'live';

// --- React hook ------------------------------------------------------------
//
// Follows the local-state-with-storage pattern of useTheme: reads the persisted
// opt-in once on mount, exposes a setter that writes through to storage, and
// derives the live state from the OWN connection status passed in by the room
// screen (e.g. RoomController's `connection`). The hook never opens a socket,
// never talks to the server, and never reflects anyone else's state.
export type UseRoomPresence = {
  // Whether presence is opted in for this room (local-only, off by default).
  enabled: boolean;
  // The state the UI should render for the user's OWN presence.
  state: PresenceState;
  // Shorthand for state === 'live'.
  isLive: boolean;
  // Toggle the per-room opt-in; persists immediately, local-only.
  setEnabled: (next: boolean) => void;
  toggle: () => void;
};

export const useRoomPresence = (
  roomHash: string,
  ownConnection: OwnConnectionStatus
): UseRoomPresence => {
  const [enabled, setEnabledState] = useState<boolean>(() => isPresenceEnabled(roomHash));

  // Re-read the per-room opt-in whenever the room changes. RoomController swaps
  // rooms in-place without remounting (hash-only swap), so without this a
  // previous room's opt-in would leak into the next — keep it strictly
  // per-room and off by default.
  useEffect(() => {
    setEnabledState(isPresenceEnabled(roomHash));
  }, [roomHash]);

  const setEnabled = useCallback(
    (next: boolean) => {
      setPresenceEnabled(roomHash, next);
      setEnabledState(next);
    },
    [roomHash]
  );

  const toggle = useCallback(() => {
    setEnabled(!isPresenceEnabled(roomHash));
  }, [roomHash, setEnabled]);

  const state = useMemo(
    () => derivePresenceState(enabled, ownConnection),
    [enabled, ownConnection]
  );

  return { enabled, state, isLive: state === 'live', setEnabled, toggle };
};

// TODO(server): optional encrypted ephemeral presence beacon.
//
// A future opt-in mode could let members who have BOTH turned presence on see
// each other's *ephemeral* liveness — never identity. The shape, when built,
// must preserve every privacy invariant:
//
//   - Rides the EXISTING end-to-end Mercure channel as just another encrypted
//     envelope (no new server endpoint, no new server-visible message type).
//     The relay still sees only ciphertext under the opaque room hash.
//   - Carries ONLY the per-room ephemeral participant id (never a stable
//     cross-room or device id) plus a short TTL/heartbeat, so it cannot be used
//     to fingerprint or correlate a person across rooms.
//   - Is decay-based: a beacon expires after its TTL with no explicit "left"
//     message, so going offline leaks nothing and there is no read-receipt.
//   - Stays server-unauthoritative: it is advisory presence that the client
//     renders if it arrives and silently ignores if it does not (graceful
//     degradation — older/quiet peers simply show no remote presence).
//
// Until that exists, this module emits NO network traffic of any kind. The
// derivation above reflects the local device's own connection only.
//
// Sketch of the eventual client surface (intentionally NOT implemented):
//   export type EphemeralPresenceBeacon = {
//     participantId: string; // per-room ephemeral id ONLY — never a device id
//     expiresAt: number;     // epoch ms; beacon is dead past this, no goodbye
//   };
//   export const decodeRemoteBeacons = (_envelope: unknown): EphemeralPresenceBeacon[] => {
//     // Parse beacons out of an already-decrypted E2E envelope, drop any past
//     // expiresAt, and return the rest for optional rendering. No-op for now.
//     return [];
//   };
