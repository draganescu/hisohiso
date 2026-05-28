// Markup lifted from app/src/pages/RoomCreator.tsx, logic stripped.

type Props = {
  roomKey?: string;
  catchUp?: boolean;
  status?: 'form' | 'creating';
};

export const RoomCreator = ({ roomKey = '', catchUp = false, status = 'form' }: Props) => {
  return (
    <main className="min-h-screen bg-[#f5f5f3] text-[#0a0a0a]">
      <div className="mx-auto flex max-w-xl flex-col gap-6 px-6 py-16">
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.35em] text-[#9a9a9a]">hisohiso</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.025em]">Open a channel.</h1>
            <p className="mt-2 text-sm text-[#6b6b6b]">
              Messages stay on this device only. Anyone with the link can join.
            </p>
          </div>
          <span className="mt-1 shrink-0 rounded-full border border-[#0a0a0a14] bg-white px-4 py-2 text-xs font-medium text-[#0a0a0a]">
            ← Your channels
          </span>
        </header>

        {status === 'form' && (
          <div className="rounded-[22px] border border-[#0a0a0a14] bg-white p-7">
            <div className="rounded-[14px] border border-[#0a0a0a14] bg-[#efefec] p-4">
              <p className="text-sm font-semibold tracking-[-0.01em]">Channel key</p>
              <p className="mt-1 text-xs leading-5 text-[#6b6b6b]">
                Optional. Encrypts knocks and message blocks. Everyone joining needs the same key — share it out of band.
              </p>
              <input
                className="mt-3 w-full rounded-[10px] border border-[#0a0a0a14] bg-white px-3 py-2 text-base focus:border-[#0a0a0a] focus:outline-none"
                placeholder="Optional"
                type="text"
                value={roomKey}
                readOnly
              />
            </div>

            <div className="mt-4 flex items-center justify-between gap-3 rounded-[14px] border border-[#0a0a0a14] bg-[#efefec] p-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold tracking-[-0.01em]">Offline catch-up</p>
                <p className="mt-1 text-xs leading-5 text-[#6b6b6b]">
                  Server keeps encrypted messages for 24h so devices that were closed can catch up. You can change this later.
                </p>
              </div>
              <div
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full ${
                  catchUp ? 'bg-[#0a0a0a]' : 'bg-[#0a0a0a33]'
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 rounded-full bg-white shadow ${
                    catchUp ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </div>
            </div>

            <div className="mt-6 w-full rounded-full border border-[#0a0a0a] bg-[#0a0a0a] py-3 text-center text-sm font-medium text-white">
              Open channel
            </div>

            <p className="mt-4 text-center text-xs text-[#9a9a9a] underline decoration-[#0a0a0a14] underline-offset-4">
              How the encryption works
            </p>
          </div>
        )}

        {status === 'creating' && (
          <div className="rounded-[22px] border border-[#0a0a0a14] bg-white p-8">
            <p className="text-sm uppercase tracking-[0.32em] text-[#9a9a9a]">Opening channel…</p>
          </div>
        )}
      </div>
    </main>
  );
};
