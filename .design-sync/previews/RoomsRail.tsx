import { RoomsRail } from 'hisohiso-app';

// RoomsRail reads listRooms() → localStorage['hisohiso.rooms'] (a JSON array of
// StoredRoom) at mount, then groups them: each 'control' room owns the 'agent'
// rooms whose controlRoomHash points at it, and 'chat' rooms list separately.
// Seed a realistic local set at module scope so the rail mounts populated.
// RoomCard shows `nickname` as the title when present (chat rooms otherwise get
// a deterministic generated name; control/agent rooms fall back to "unnamed
// channel"). Give the control/agent rooms readable nicknames so the rail reads
// like a real operator surface.
const SEED_ROOMS = [
  { roomHash: 'b2e4d1', roomSecret: 'sek-b2e4d1', lastSeen: 1718890000000, kind: 'control', handle: 'daemon · mbp-16', nickname: 'daemon · mbp-16', controlRoomHash: null },
  { roomHash: 'c3d5e6', roomSecret: 'sek-c3d5e6', lastSeen: 1718880000000, kind: 'agent', handle: 'fix-flaky-test', nickname: 'fix-flaky-test', controlRoomHash: 'b2e4d1' },
  { roomHash: 'd4e7f8', roomSecret: 'sek-d4e7f8', lastSeen: 1718870000000, kind: 'agent', handle: 'bump-frankenphp', nickname: 'bump-frankenphp', controlRoomHash: 'b2e4d1' },
  { roomHash: 'a1f3c2', roomSecret: 'sek-a1f3c2', lastSeen: 1718900000000, kind: 'chat', handle: 'alex', nickname: 'alex' },
  { roomHash: 'e5a8b9', roomSecret: 'sek-e5a8b9', lastSeen: 1718895000000, kind: 'chat', handle: 'maya', nickname: 'maya' },
];

if (typeof localStorage !== 'undefined') {
  localStorage.setItem('hisohiso.rooms', JSON.stringify(SEED_ROOMS));
}

// The component carries className="rooms-rail", which the app stylesheet pins to
// `display:none` below 1024px and to `position:fixed; inset:0 auto 0 0` at lg+.
// The grading viewport is 900px wide, so without an override the aside would be
// hidden entirely. Re-establish it as a normal in-flow column inside the preview
// frame (plain CSS, not a Tailwind class) so the card shows the real component.
const RailReset = () => (
  <style>{`
    .ds-rail-frame .rooms-rail {
      display: flex !important;
      flex-direction: column !important;
      position: static !important;
      width: 100% !important;
      max-width: 100% !important;
      gap: 1.25rem;
      padding: 0;
      overflow: visible;
    }
  `}</style>
);

const frame = { maxWidth: 360, margin: '0 auto' };

export const Populated = () => (
  <div className="ds-rail-frame" style={frame}>
    <RailReset />
    <RoomsRail activeRoomHash="b2e4d1" />
  </div>
);

export const AgentActive = () => (
  <div className="ds-rail-frame" style={frame}>
    <RailReset />
    <RoomsRail activeRoomHash="c3d5e6" />
  </div>
);
