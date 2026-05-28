// Markup lifted from app/src/pages/RoomsPage.tsx, logic stripped.
// Mirrors the JSX 1:1 — only data inputs differ.

export type StoredRoom = {
  roomHash: string;
  nickname?: string;
  color?: string;
  handle?: string;
  joined: boolean;
  relativeTime: string;
};

type Props = {
  rooms?: StoredRoom[];
  joinValue?: string;
  joinPlaceholder?: string;
};

export const RoomsPage = ({ rooms = [], joinValue = '', joinPlaceholder = 'https://hisohiso.org/room#…' }: Props) => {
  return (
    <main className="min-h-screen bg-[#f5f5f3] text-[#0a0a0a]">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-16">
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.35em] text-[#9a9a9a]">hisohiso</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.025em]">Your channels.</h1>
            <p className="mt-2 text-sm text-[#6b6b6b]">Stored on this device only.</p>
          </div>
          <a className="mt-1 shrink-0 rounded-full border border-[#0a0a0a] bg-[#0a0a0a] px-5 py-2.5 text-sm font-medium text-white" href="#">
            Open a channel
          </a>
        </header>

        <section className="rounded-[22px] border border-[#0a0a0a14] bg-white p-6">
          <h2 className="text-lg font-semibold tracking-[-0.015em]">Join with a link.</h2>
          <p className="mt-2 text-sm text-[#6b6b6b]">Paste a channel URL or secret.</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input
              className="flex-1 rounded-full border border-[#0a0a0a14] bg-white px-4 py-2.5 text-sm focus:border-[#0a0a0a] focus:outline-none"
              placeholder={joinPlaceholder}
              value={joinValue}
              readOnly
            />
            <button
              className="rounded-full border border-[#0a0a0a] bg-[#0a0a0a] px-5 py-2.5 text-sm font-medium text-white"
              type="button"
            >
              Join
            </button>
          </div>
          <button
            className="mt-4 rounded-full border border-[#0a0a0a14] bg-white px-5 py-2 text-sm font-medium text-[#0a0a0a]"
            type="button"
          >
            Scan QR code
          </button>
        </section>

        {rooms.length === 0 && (
          <div className="rounded-[22px] border border-dashed border-[#0a0a0a14] bg-white p-8">
            <p className="text-[#6b6b6b]">No channels yet. Open one or paste a link above.</p>
            <a className="mt-4 inline-block text-sm font-medium text-[#0a0a0a] underline decoration-[#0a0a0a14] underline-offset-4" href="#">
              Open a channel →
            </a>
          </div>
        )}

        {rooms.length > 0 && (
          <div className="flex flex-col gap-3">
            {rooms.map((room) => {
              const displayName = room.nickname || 'Unnamed channel';
              return (
                <div
                  key={room.roomHash}
                  className="flex overflow-hidden rounded-[22px] border border-[#0a0a0a14] bg-white"
                >
                  <div className="w-1 shrink-0" style={{ backgroundColor: room.color || '#c4c4c4' }} />
                  <div className="flex-1 p-5 sm:p-6">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: room.color || '#c4c4c4' }} />
                          <span className="min-w-0 truncate text-lg font-semibold tracking-[-0.015em]">
                            {displayName}
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#9a9a9a]">
                          <span>{room.joined ? 'Joined' : 'Link saved'}</span>
                          {room.handle && (
                            <>
                              <span className="text-[#c4c4c4]">·</span>
                              <span>{room.handle}</span>
                            </>
                          )}
                          <span className="text-[#c4c4c4]">·</span>
                          <span>{room.relativeTime}</span>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <a className="rounded-full border border-[#0a0a0a] bg-[#0a0a0a] px-4 py-1.5 text-xs font-medium text-white" href="#">
                          Open
                        </a>
                        <span className="rounded-full border border-[#0a0a0a14] bg-white px-4 py-1.5 text-xs font-medium text-[#0a0a0a]">
                          Forget
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-[#9a9a9a]">
          <span className="font-medium text-[#6b6b6b] underline decoration-[#0a0a0a14] underline-offset-4">
            What is hisohiso?
          </span>
          <span className="font-medium text-[#6b6b6b] underline decoration-[#0a0a0a14] underline-offset-4">
            Protocol
          </span>
          <span className="font-medium text-[#6b6b6b] underline decoration-[#0a0a0a14] underline-offset-4">
            Source
          </span>
        </div>
      </div>
    </main>
  );
};
