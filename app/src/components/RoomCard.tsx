// Richer card for the /rooms list (replaces the compact RoomRow there). The
// switcher inside RoomController keeps using RoomRow — this is a separate, larger
// surface tuned for the index page, sharing the same KIND_META tones so the two
// stay visually in sync.
//
// PRIVACY (read before changing anything here):
//   - The MASKED last-message preview NEVER renders plaintext. It shows fixed
//     "••• ••• •••" dots plus a timestamp. The message text stays decrypted on
//     this device inside Dexie; the card reads only `lastMessageMeta` (timestamp
//     + existence flag), not content. Masking is presentational, not a crypto
//     state — there is no plaintext to leak from this component.
//   - The Avatar seed is the VOLUNTARY per-room handle when present, otherwise a
//     per-mount EPHEMERAL id. It is NEVER seeded from roomHash/roomSecret/color
//     (room-scoped, cross-room/cross-reload stable → would let the same avatar
//     reappear across rooms / be fingerprinted). The ephemeral fallback is minted
//     fresh per mount, so a handle-less room shows a throwaway avatar that cannot
//     correlate the operator anywhere.
import { useEffect, useRef, useState } from 'react';
import type { StoredRoom } from '../lib/storage';
import { generateRoomName } from '../lib/room-names';
import { lastMessageMeta, type LastMessageMeta } from '../lib/db';
import { randomBytes, base64UrlEncode } from '../lib/crypto';
import { getPendingKnockCount, PENDING_KNOCKS_EVENT } from '../lib/pending-knocks';
import Avatar from './Avatar';
import { KIND_META } from './RoomRow';

type Props = {
  room: StoredRoom;
  /** Renders the card as an `<a href>` so cmd-click / new-tab behave. */
  href: string;
  /** Kebab → Rename. */
  onRename?: (next: string) => void;
  /** Kebab → Forget. */
  onForget?: () => void;
  /**
   * Optional plain-click handler. When set, a normal left-click is intercepted
   * (preventDefault) and this runs instead of following `href` — used by the
   * desktop rail to swap the room via hash (no full page reload) while already
   * on /room. The `href` stays intact so cmd/ctrl/middle-click still open a new
   * tab via the browser's native handling.
   */
  onSelect?: () => void;
  /** Highlights the card as the room currently shown in the main pane. */
  isCurrent?: boolean;
};

const formatStamp = (timestamp: number): string =>
  new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

// Three masked groups standing in for the (deliberately hidden) message text.
const MASK = '••• ••• •••';

export const RoomCard = ({ room, href, onRename, onForget, onSelect, isCurrent }: Props) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(room.nickname ?? '');
  const [meta, setMeta] = useState<LastMessageMeta | null>(null);
  // Content-free count of join requests waiting on THIS room, written by the
  // open room screen when a knock arrives over the E2E channel (see
  // lib/pending-knocks.ts). Only an integer is read here — never a note,
  // pubkey, or any identity — so the badge can never leak who is knocking.
  const [pendingKnocks, setPendingKnocks] = useState(() => getPendingKnockCount(room.roomHash));
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Ephemeral avatar seed for handle-less rooms: minted once per mount, never
  // persisted, never derived from a stable room id. Regenerates every session.
  const [ephemeralSeed] = useState(() => base64UrlEncode(randomBytes(9)));

  const badge = KIND_META[room.kind] ?? KIND_META.chat;
  const fallbackName = room.kind === 'chat' ? generateRoomName(room.roomHash) : 'unnamed channel';
  const displayName = room.nickname || fallbackName;
  const hasMenu = !!(onRename || onForget);

  // Voluntary handle wins; otherwise a throwaway ephemeral id (see privacy note).
  const avatarSeed = room.handle && room.handle.trim().length > 0 ? room.handle : ephemeralSeed;

  // Pull only the masked preview's metadata (timestamp + existence) — never text.
  useEffect(() => {
    let alive = true;
    void lastMessageMeta(room.roomHash).then((m) => {
      if (alive) setMeta(m);
    });
    return () => {
      alive = false;
    };
  }, [room.roomHash]);

  // Keep the pending-knock badge fresh. The custom event fires for changes made
  // on THIS page (e.g. the room screen mounted in a desktop rail beside us); the
  // native `storage` event fires for changes from ANOTHER tab/page (the common
  // case: the room screen wrote the count, then we navigated to /rooms). We
  // re-read from storage on either, scoped to this room's hash.
  useEffect(() => {
    const refresh = () => setPendingKnocks(getPendingKnockCount(room.roomHash));
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<{ roomHash?: string }>).detail;
      if (!detail || detail.roomHash === room.roomHash) refresh();
    };
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === `hisohiso.pending_knocks.${room.roomHash}`) refresh();
    };
    // Re-read on mount in case the count changed between the initial useState and
    // the listeners attaching.
    refresh();
    window.addEventListener(PENDING_KNOCKS_EVENT, onCustom);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(PENDING_KNOCKS_EVENT, onCustom);
      window.removeEventListener('storage', onStorage);
    };
  }, [room.roomHash]);

  // Close the kebab popover on outside tap (mirrors RoomRow's behaviour).
  useEffect(() => {
    if (!menuOpen) return;
    const onDocPointer = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDocPointer);
    return () => document.removeEventListener('pointerdown', onDocPointer);
  }, [menuOpen]);

  const commitRename = () => {
    if (onRename) onRename(draft.trim());
    setEditing(false);
  };

  const cardInner = (
    <>
      <Avatar seed={avatarSeed} size="lg" className="shrink-0 shadow-[var(--shadow-soft)]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {editing ? (
            <input
              onClick={(e) => e.preventDefault()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commitRename();
                else if (e.key === 'Escape') {
                  setDraft(room.nickname ?? '');
                  setEditing(false);
                }
              }}
              onBlur={commitRename}
              onChange={(e) => setDraft(e.target.value)}
              value={draft}
              autoFocus
              className="input-field min-w-0 flex-1 rounded-md px-2 py-1 text-base font-semibold"
              placeholder={displayName}
            />
          ) : (
            <p className="truncate text-base font-semibold tracking-[-0.01em]">{displayName}</p>
          )}
          {!editing && (
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.12em] ${badge.tone}`}
            >
              {badge.label}
            </span>
          )}
          {!editing && pendingKnocks > 0 && (
            <span
              className="shrink-0 rounded-full border border-accent bg-accent-soft px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-accent-strong"
              title={`${pendingKnocks} join ${pendingKnocks === 1 ? 'request' : 'requests'} waiting`}
            >
              {pendingKnocks === 1 ? 'knock' : `${pendingKnocks} knocks`}
            </span>
          )}
        </div>
        {/* Masked preview: fixed dots, never the message text. Only show the dots
            when the latest message actually carries displayable content, so the
            mask never implies content that isn't there (system/echo rows). */}
        <div className="mt-1.5 flex items-center gap-2 text-sm text-ink-dim">
          {meta?.hasContent && (
            <span className="select-none font-mono tracking-[0.2em] text-ink-fade" aria-hidden="true">
              {MASK}
            </span>
          )}
          {meta && (
            <span className="shrink-0 whitespace-nowrap text-xs text-ink-dim">{formatStamp(meta.timestamp)}</span>
          )}
        </div>
      </div>
    </>
  );

  const baseClass =
    'room-card flex w-full items-center gap-3.5 rounded-[18px] px-4 py-3.5 text-left no-underline transition-colors' +
    (isCurrent ? ' room-card-current' : '');

  let cardEl: React.ReactNode;
  if (editing) {
    cardEl = <div className={baseClass}>{cardInner}</div>;
  } else {
    cardEl = (
      <a
        href={href}
        className={baseClass}
        aria-current={isCurrent ? 'true' : undefined}
        onClick={
          onSelect
            ? (e) => {
                // Let the browser handle cmd/ctrl/middle-click + new-tab modifiers
                // natively (open in new tab). Otherwise intercept and swap the
                // room without a full page reload.
                if (e.defaultPrevented) return;
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                onSelect();
              }
            : undefined
        }
      >
        {cardInner}
      </a>
    );
  }

  return (
    <div
      className="room-card-shell relative flex items-stretch gap-1"
      style={{ ['--room-accent' as string]: room.color || 'var(--ink-fade)' }}
    >
      <div className="min-w-0 flex-1">{cardEl}</div>
      {hasMenu && !editing && (
        <div ref={menuRef} className="absolute right-2.5 top-2.5 z-20">
          <button
            type="button"
            aria-label="channel actions"
            className="rounded-full px-2 py-1.5 text-ink-dim hover:bg-bg hover:text-ink"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
          >
            ⋮
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-30 mt-1 w-36 overflow-hidden rounded-[12px] border border-rule bg-surface shadow-[var(--shadow-float)]"
            >
              {onRename && (
                <button
                  role="menuitem"
                  type="button"
                  className="block w-full px-3 py-2 text-left text-sm text-ink hover:bg-bg"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenuOpen(false);
                    setDraft(room.nickname ?? '');
                    setEditing(true);
                  }}
                >
                  rename
                </button>
              )}
              {onForget && (
                <button
                  role="menuitem"
                  type="button"
                  className="block w-full border-t border-rule px-3 py-2 text-left text-sm text-danger hover:bg-bg"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenuOpen(false);
                    onForget();
                  }}
                >
                  forget
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default RoomCard;
