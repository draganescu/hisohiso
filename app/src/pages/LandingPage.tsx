const LandingPage = () => {
  return (
    <main className="min-h-screen bg-[#efe7d5] text-[#171613]">
      <div className="mx-auto flex max-w-4xl flex-col gap-12 px-6 py-16">
        <section className="rounded-2xl border-2 border-[#171613] bg-gradient-to-br from-[#f6efdf] via-[#efe0c7] to-[#e5cda8] p-10 shadow-[0_20px_40px_rgba(23,22,19,0.12)]">
          <p className="text-xs uppercase tracking-[0.3em] text-[#3a362f]">Hisohiso</p>
          <h1 className="mt-4 text-4xl font-semibold leading-tight md:text-5xl">
            Fuck your bubble color.
          </h1>
          <p className="mt-4 text-lg text-[#2c2823]">
            Just chat. No accounts. No tracking. No feeds. No blue vs green.
          </p>
          <a
            className="mt-8 inline-flex items-center justify-center rounded-full border-2 border-[#171613] bg-[#171613] px-6 py-3 font-semibold tracking-wide text-[#f6f0e8] transition hover:border-[#b43d1f] hover:bg-[#d64f2a]"
            href="/new"
          >
            Start a room
          </a>
        </section>

        <section className="rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-8 shadow-[0_14px_30px_rgba(23,22,19,0.1)]">
          <h2 className="text-2xl font-semibold">It&apos;s just a room.</h2>
          <p className="mt-3 text-[#3a362f]">
            You open a link. You share it. People knock. You approve. You talk. Anyone can disband the room.
            No profiles. No phone numbers. No cloud archive. No algorithm.
          </p>
        </section>

        <section className="rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-8 shadow-[0_14px_30px_rgba(23,22,19,0.1)]">
          <h2 className="text-2xl font-semibold">Everyone same color.</h2>
          <p className="mt-3 text-[#3a362f]">
            Messaging turned into identity. Blue vs green. Verified vs unverified. Real name vs username. We don&apos;t
            care. Here, everyone is just text in the same room.
          </p>
        </section>

        <section className="rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-8 shadow-[0_14px_30px_rgba(23,22,19,0.1)]">
          <h2 className="text-2xl font-semibold">Private by design.</h2>
          <p className="mt-3 text-[#3a362f]">
            Messages are encrypted in your browser. The server only routes unreadable data. Messages live on your
            device. Lose the link, lose the room.
          </p>
        </section>

        <section className="rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-8 shadow-[0_14px_30px_rgba(23,22,19,0.1)]">
          <h2 className="text-2xl font-semibold">Not a platform.</h2>
          <p className="mt-3 text-[#3a362f]">
            Not social media. Not enterprise chat. Not productivity software. Just a shared space for people who
            already know each other.
          </p>
        </section>

        <section className="rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-8 shadow-[0_14px_30px_rgba(23,22,19,0.1)]">
          <h2 className="text-2xl font-semibold">Open.</h2>
          <p className="mt-3 text-[#3a362f]">
            The protocol is simple. Run your own server. Add features if you want. Charge for them if you want. Or
            just use it.
          </p>
        </section>

        <section className="rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-8 shadow-[0_14px_30px_rgba(23,22,19,0.1)]">
          <h2 className="text-2xl font-semibold">Repo + easy deploy</h2>
          <p className="mt-3 text-[#3a362f]">
            The code lives in the{' '}
            <a className="underline" href="https://github.com/draganescu/hisohiso">
              hisohiso
            </a>{' '}
            repo. It ships with Docker Compose, FrankenPHP/Caddy, and Mercure wiring, so most people can self-host it
            by setting a few environment variables and running one compose command.
          </p>
          <p className="mt-3 text-[#3a362f]">
            If your server can run Docker and expose HTTP/HTTPS (VPS, homelab box, or container host), you can deploy
            it. Clone, configure, run, and share a room link.
          </p>
        </section>

        <footer className="text-center text-sm text-[#3a362f]">
          Minimal protocol. Local storage. No accounts.
        </footer>
      </div>
    </main>
  );
};

export default LandingPage;
