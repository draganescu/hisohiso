// Shared compact row used by both the channels list at /rooms and the Switch
// channels modal inside RoomController. One implementation, two consumers,
// configured by props: pass `href` to make the whole row a link (rooms list)
// or `onSelect` to make it a button (switcher). Optional `onRename` /
// `onForget` enable a kebab menu; optional `isCurrent` renders the "current"
// pill (switcher only).
import { useEffect, useRef, useState } from 'react';
import type { StoredRoom } from '../lib/storage';
import { generateRoomName } from '../lib/room-names';

// Kind-badge styling lives here so both consumers stay in sync. 'control' uses
// the accent palette so the operator's command surface reads as distinct;
// 'agent' and 'chat' share the muted surface tone — they're peer rooms in
// terms of UI weight.
const KIND_META: Record<StoredRoom['kind'], { label: string; tone: string }> = {
  control: { label: 'Control', tone: 'border-accent/40 bg-accent-soft text-accent-strong' },
  agent: { label: 'Agent', tone: 'border-rule bg-surface text-ink-soft' },
  chat: { label: 'Chat', tone: 'border-rule bg-surface text-ink-soft' },
};

type Props = {
  room: StoredRoom;
  /** True on the row matching the currently-open room; renders a "current" pill. Switcher-only. */
  isCurrent?: boolean;
  /** Set to "Joined" if the phone holds a participant token for this room, otherwise "Link saved". */
  joinedLabel?: string;
  /** If provided, the row is rendered as an `<a href>`. Used by /rooms so cmd-click etc work. */
  href?: string;
  /** If provided (and `href` is not), the row is rendered as a `<button>` invoking this. Used by the switcher. */
  onSelect?: () => void;
  /** Enables the kebab menu's Rename action. */
  onRename?: (next: string) => void;
  /** Enables the kebab menu's Forget action. */
  onForget?: () => void;
};

export const RoomRow = ({ room, isCurrent, joinedLabel, href, onSelect, onRename, onForget }: Props) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(room.nickname ?? '');
  const menuRef = useRef<HTMLDivElement | null>(null);

  const hasMenu = !!(onRename || onForget);
  const badge = KIND_META[room.kind] ?? KIND_META.chat;
  // Chat rooms get a deterministic punk-pseudo fallback derived from the
  // room hash (see room-names.ts). Same room hash → same display name on
  // every device, never written to storage so the user's Rename always
  // beats it and renaming to empty restores it. Non-chat kinds keep the
  // bland "Unnamed channel" since control gets the daemon hostname and
  // agent rooms are named explicitly by the daemon on spawn.
  const fallbackName = room.kind === 'chat' ? generateRoomName(room.roomHash) : 'Unnamed channel';
  const displayName = room.nickname || fallbackName;

  // Close the kebab popover on any outside tap. Captured at document level so
  // tapping another row's kebab closes ours first (the natural mental model:
  // one menu open at a time).
  useEffect(() => {
    if (!menuOpen) return;
    const onDocPointer = (e: PointerEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDocPointer);
    return () => document.removeEventListener('pointerdown', onDocPointer);
  }, [menuOpen]);

  const commitRename = () => {
    const trimmed = draft.trim();
    if (onRename) onRename(trimmed);
    setEditing(false);
  };

  // The interactive surface of the row — color dot + name + meta + badge +
  // optional current pill. Rendered identically inside an <a> or a <button>
  // so the two callers produce visually identical rows.
  const innerContent = (
    <>
      <div
        className="h-3 w-3 shrink-0 rounded-full"
        style={{ backgroundColor: room.color || 'var(--ink-fade)' }}
      />
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            // Stop click/keypress here from bubbling to the row's link/button —
            // otherwise tapping into the input would navigate to the room.
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
            className="input-field w-full rounded-md px-2 py-1 text-sm font-medium"
            placeholder={displayName}
          />
        ) : (
          <p className={`truncate text-sm font-medium ${isCurrent ? '' : ''}`}>{displayName}</p>
        )}
        {room.handle && !editing && (
          <p className={`truncate text-xs ${isCurrent ? 'text-ink-fade' : 'text-ink-dim'}`}>{room.handle}</p>
        )}
      </div>
      {joinedLabel && !editing && (
        <span className={`shrink-0 text-[0.625rem] uppercase tracking-[0.12em] ${isCurrent ? 'text-ink-fade' : 'text-ink-dim'}`}>
          {joinedLabel}
        </span>
      )}
      {!editing && (
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.12em] ${badge.tone}`}>
          {badge.label}
        </span>
      )}
    </>
  );

  // Wrapper element: `<a>` if href, `<button>` if onSelect, plain div otherwise
  // (defensive — every real use site supplies one or the other).
  const rowBaseClass = `flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors no-underline ${
    isCurrent ? 'bg-filled text-on-ink' : 'text-ink hover:bg-bg'
  }`;

  // Editing mode swaps in a div instead of a link/button so the autoFocus
  // input isn't fighting the parent's onClick navigation handler.
  let rowEl: React.ReactNode;
  if (editing) {
    rowEl = <div className={rowBaseClass}>{innerContent}</div>;
  } else if (href) {
    rowEl = <a href={href} className={rowBaseClass}>{innerContent}</a>;
  } else if (onSelect) {
    rowEl = (
      <button type="button" onClick={onSelect} className={rowBaseClass}>
        {innerContent}
      </button>
    );
  } else {
    rowEl = <div className={rowBaseClass}>{innerContent}</div>;
  }

  return (
    <div className="relative flex items-center gap-1">
      <div className="min-w-0 flex-1">{rowEl}</div>
      {hasMenu && !editing && (
        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            aria-label="Channel actions"
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
                  Rename
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
                  Forget
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
