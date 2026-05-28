// Markup lifted from app/src/pages/RoomController.tsx (roomState === 'LOBBY_WAITING').

type Props = {
  roomKey?: string;
  note?: string;
  knockSent?: boolean;
  knockNotice?: string;
};

export const JoinForm = ({ roomKey = '', note = '', knockSent = false, knockNotice }: Props) => {
  return (
    <main className="min-h-screen bg-[#f5f5f3] text-[#0a0a0a]">
      <div className="mx-auto flex max-w-xl flex-col gap-5 px-6 py-16">
        <p className="text-[11px] uppercase tracking-[0.35em] text-[#9a9a9a]">hisohiso</p>

        <div className="rounded-[22px] border border-[#0a0a0a14] bg-white p-8">
          <h1 className="text-3xl font-semibold tracking-[-0.025em]">Join this channel.</h1>
          <p className="mt-3 text-[#6b6b6b]">Ask to be let in. Someone inside has to approve you.</p>

          <input
            className="mt-6 w-full rounded-[10px] border border-[#0a0a0a14] bg-white px-3 py-2.5 text-base focus:border-[#0a0a0a] focus:outline-none"
            placeholder="Channel key or pairing code"
            type="text"
            value={roomKey}
            readOnly
          />
          <p className="mt-2 text-xs text-[#9a9a9a]">
            Saved on this device. Used to encrypt your knock and chat messages.
          </p>

          <textarea
            className="mt-4 w-full rounded-[10px] border border-[#0a0a0a14] bg-white px-3 py-2.5 text-base focus:border-[#0a0a0a] focus:outline-none"
            placeholder="Optional note (e.g. who you are)"
            rows={3}
            value={note}
            readOnly
          />

          <div className="mt-5 flex flex-col gap-3 sm:flex-row">
            <div className="rounded-full border border-[#0a0a0a] bg-[#0a0a0a] px-5 py-2.5 text-sm font-medium text-white">
              Request to join
            </div>
            <div className="rounded-full border border-[#0a0a0a14] bg-white px-5 py-2.5 text-center text-sm font-medium text-[#0a0a0a]">
              Your channels
            </div>
          </div>

          {(knockSent || knockNotice) && (
            <p className="mt-5 text-xs uppercase tracking-[0.28em] text-[#9a9a9a]">
              {knockNotice || 'Waiting for approval…'}
            </p>
          )}

          <p className="mt-6 text-xs text-[#9a9a9a] underline decoration-[#0a0a0a14] underline-offset-4">
            What is hisohiso?
          </p>
        </div>
      </div>
    </main>
  );
};
