const NotFound = () => {
  return (
    <main className="min-h-[100dvh] bg-bg text-ink">
      <div className="mx-auto flex max-w-xl flex-col gap-4 px-6 py-16">
        <p className="text-[0.6875rem] uppercase tracking-[0.35em] text-ink-dim">hisohiso</p>
        <h1 className="text-3xl font-semibold tracking-[-0.025em]">channel not found.</h1>
        <p className="text-ink-soft">
          the link is incomplete or the channel has been closed.
        </p>
        <div className="mt-2 flex flex-wrap gap-3">
          <a
            className="inline-flex items-center justify-center rounded-full border border-ink bg-filled px-5 py-2 text-sm font-medium text-on-ink"
            href="/rooms"
          >
            your rooms
          </a>
          <a
            className="inline-flex items-center justify-center rounded-full border border-rule bg-surface px-5 py-2 text-sm font-medium text-ink"
            href="https://www.hisohiso.org/"
          >
            what is this?
          </a>
        </div>
      </div>
    </main>
  );
};

export default NotFound;
