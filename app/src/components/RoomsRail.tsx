// Desktop-only persistent rooms rail. Shown at lg+ beside the routed room view
// so the operator can glance the local channel list and hop rooms without
// returning to /rooms. Below lg it renders nothing (display:none on the shell),
// keeping the mobile single-pane experience byte-for-byte unchanged.
//
// PRIVACY: this is the same local-only surface as the /rooms index — it reads
// listRooms() (localStorage, this device only) and renders RoomCard, which
// already masks message previews and uses privacy-safe avatar seeds. No new
// data, network, or cross-room linkage is introduced here.
//
// NAVIGATION: top-level routes in this app are real full page loads, but the
// in-room channel switch is a hash swap (SPA-ish). So when the rail is shown
// inside RoomController (always on /room), tapping a card calls `onSelectRoom`
// to swap the hash with no reload. cmd/ctrl/middle-click still open a new tab
// via the card's intact `href` (handled inside RoomCard).
//
// LIMITATION: this is a true two-pane only on /room (the route that owns the
// rail). /rooms keeps its existing full-page index — we do not mirror the rail
// there to avoid a second, redundant rooms surface. The rail's room cards are
// read-only navigation (no rename/forget kebab); those actions stay on the
// /rooms index. TODO: the shared QrModal (rendered inside the room view) still
// centers over the full viewport at lg+ rather than the room pane — minor; its
// backdrop covers the rail and the max-w-sm card stays fully visible/usable.
import { useCallback, useEffect, useState } from 'react';
import { listRooms, type StoredRoom } from '../lib/storage';
import { groupOpenChannels } from '../lib/room-grouping';
import { RoomCard } from './RoomCard';
import { GroupedChannelList } from './GroupedChannelList';

type Props = {
  /** roomHash of the room currently shown in the main pane (for highlight). */
  activeRoomHash?: string | null;
  /**
   * Swap the active room without a full reload (hash swap). Receives the
   * tapped room's URL secret. When omitted, cards fall back to plain `href`
   * full-page navigation.
   */
  onSelectRoom?: (roomSecret: string) => void;
};

const RoomsRail = ({ activeRoomHash, onSelectRoom }: Props) => {
  const [rooms, setRooms] = useState<StoredRoom[]>([]);

  const refresh = useCallback(() => setRooms(listRooms()), []);

  // Re-read the local list on mount and whenever the tab regains focus or a
  // sibling tab mutates localStorage (rename/forget/new room). listRooms() is a
  // cheap sync localStorage read, so polling cost is nil.
  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [refresh]);

  // Re-read when the active room changes (e.g. after a hash swap) so the new
  // room's lastSeen ordering / highlight settle.
  useEffect(() => {
    refresh();
  }, [activeRoomHash, refresh]);

  const { groups, orphanAgents, hasAny: hasOpenChannels } = groupOpenChannels(rooms);
  const conversations = rooms.filter((room) => room.kind === 'chat');

  // The rail is read-only navigation; rename/forget stay on the /rooms index to
  // keep the in-room surface focused on hopping rooms.
  const renderRoomCard = (room: StoredRoom) => (
    <RoomCard
      key={room.roomHash}
      room={room}
      href={`/room#${room.roomSecret}`}
      isCurrent={activeRoomHash != null && room.roomHash === activeRoomHash}
      onSelect={onSelectRoom ? () => onSelectRoom(room.roomSecret) : undefined}
    />
  );

  return (
    <aside className="rooms-rail" aria-label="your rooms">
      <div className="flex items-center justify-between gap-3 px-1">
        <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.32em] text-ink-dim">
          your rooms
        </p>
        <a
          href="/new"
          className="rounded-full border border-rule bg-surface px-3 py-1 text-xs font-medium text-ink transition hover:border-ink"
        >
          open
        </a>
      </div>

      {rooms.length === 0 && (
        <div className="glass-panel rounded-[18px] border-dashed p-4 text-sm text-ink-soft">
          no rooms yet.{' '}
          <a className="font-medium text-ink underline decoration-rule underline-offset-4" href="/new">
            open a channel →
          </a>
        </div>
      )}

      {hasOpenChannels && (
        <section className="flex flex-col gap-2.5">
          <h2 className="px-1 text-[0.625rem] font-semibold uppercase tracking-[0.28em] text-ink-dim">
            open channels
          </h2>
          <GroupedChannelList groups={groups} orphanAgents={orphanAgents} renderRow={renderRoomCard} />
        </section>
      )}

      {conversations.length > 0 && (
        <section className="flex flex-col gap-2.5">
          {hasOpenChannels && (
            <h2 className="px-1 text-[0.625rem] font-semibold uppercase tracking-[0.28em] text-ink-dim">
              conversations
            </h2>
          )}
          {conversations.map(renderRoomCard)}
        </section>
      )}

      <a
        href="/rooms"
        className="mt-1 px-1 text-xs font-medium text-ink-soft underline decoration-rule underline-offset-4 hover:text-ink"
      >
        all rooms →
      </a>
    </aside>
  );
};

export default RoomsRail;
