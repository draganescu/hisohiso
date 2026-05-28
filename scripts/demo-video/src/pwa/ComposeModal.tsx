// Markup lifted from app/src/pages/RoomController.tsx (full-screen modal composer).
//
// Sizing note: the PWA's `composer-overlay` class sets `height: var(--app-height)`
// which is 100dvh on a phone. In Remotion that resolves to 100vh = the full
// composition height (1920), not the phone screen we render inside — so we drop
// the class and let the parent's inset:0 own the sizing.

type Props = {
  handle?: string;
  value?: string;
  sendDisabled?: boolean;
};

export const ComposeModal = ({ handle = 'andrei', value = '', sendDisabled = true }: Props) => {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        backgroundColor: '#f5f5f3',
        color: '#0a0a0a',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div className="flex items-center justify-between border-b border-[#0a0a0a14] bg-white px-4 py-3 sm:py-4">
        <button className="text-sm font-medium text-[#6b6b6b]" type="button">
          Cancel
        </button>
        <p className="text-sm font-semibold tracking-[-0.015em]">New message</p>
        <button
          className={`rounded-full border border-[#0a0a0a] bg-[#0a0a0a] px-4 py-1.5 text-xs font-medium text-white ${
            sendDisabled ? 'cursor-not-allowed opacity-30' : ''
          }`}
          type="button"
          disabled={sendDisabled}
        >
          Send
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex items-start justify-between gap-3 overflow-hidden">
          <div>
            <p className="text-[11px] uppercase tracking-[0.2em] text-[#9a9a9a]">From</p>
            <p className="mt-1 text-base font-medium text-[#0a0a0a]">{handle || 'You'}</p>
          </div>
        </div>

        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <textarea
            className="block min-h-[6rem] w-full flex-1 resize-none overflow-y-auto border-0 bg-transparent pr-2 text-[17px] leading-7 text-[#0a0a0a] outline-none"
            placeholder="Write a message…"
            value={value}
            readOnly
          />
        </div>
      </div>
    </div>
  );
};
