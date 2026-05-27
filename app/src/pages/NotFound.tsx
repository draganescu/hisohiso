const NotFound = () => {
  return (
    <main className="min-h-screen bg-[#f5f5f3] text-[#0a0a0a]">
      <div className="mx-auto flex max-w-xl flex-col gap-4 px-6 py-16">
        <p className="text-[11px] uppercase tracking-[0.35em] text-[#9a9a9a]">hisohiso</p>
        <h1 className="text-3xl font-semibold tracking-[-0.025em]">Channel not found.</h1>
        <p className="text-[#6b6b6b]">
          The link is incomplete or the channel has been closed.
        </p>
        <div className="mt-2 flex flex-wrap gap-3">
          <a
            className="inline-flex items-center justify-center rounded-full border border-[#0a0a0a] bg-[#0a0a0a] px-5 py-2 text-sm font-medium text-white"
            href="/rooms"
          >
            Your channels
          </a>
          <a
            className="inline-flex items-center justify-center rounded-full border border-[#0a0a0a14] bg-white px-5 py-2 text-sm font-medium text-[#0a0a0a]"
            href="/launch2/"
          >
            What is this?
          </a>
        </div>
      </div>
    </main>
  );
};

export default NotFound;
