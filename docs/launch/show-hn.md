# Show HN draft

## Title

```
Show HN: Hisohiso – phone-native control plane for terminal AI agents (E2E encrypted)
```

Keep under 80 characters. Don't use ALL CAPS. Don't add an exclamation point.

## Submitting

- URL: `https://hisohiso.org/`
- Submit Tuesday or Wednesday between 7am–9am US Eastern.
- Do not ask friends to upvote — flagged content disappears fast.

## First comment (post within 60 seconds of submission)

```
Hi HN — I built this because both options for talking to a terminal AI
agent from my phone are broken in opposite ways.

Native apps (Claude, Codex): the connection to your terminal session
silently breaks and can't be re-established. You think you're talking
to your laptop and you aren't. Mystery state, no recovery.

Telegram / WhatsApp bridges: rock-solid transport, but the UI is chat.
No diffs, no buttons, no swipe-to-prioritize, no way to stop an agent
that's gone off the rails.

Hisohiso sits in between, on purpose:

1. A daemon on your laptop. From your phone you can spawn agents,
   kill ones you don't want, list what's running, and start fresh
   when one gets stuck. If the daemon is unreachable, you actually
   know — your machine is down. No mysterious "session expired."

2. A PWA with a UI designed for the phone × agent intersection. Long
   agent output collapses, choices render as touch buttons, sortable
   lists are swipeable, diffs and confirmations have their own block
   types. Not chat retrofitted for agents.

E2E encrypted (AES-GCM, room secrets stay in the URL hash, server only
routes ciphertext). Opt-in 24h encrypted outbox per room if you want
offline catch-up. Self-host the server if you want; the whole stack
is GPLv3.

Today it officially supports Claude Code. Other agents (aider, codex
CLI, goose, bash, python) ship but are experimental.

Install is `curl … | sh` and the app is a PWA — no app store. If that's
a dealbreaker, this isn't built for you yet. If you live in a terminal
half the day and want your AI agent in your pocket the rest of the day,
give it a try.

Repo: https://github.com/draganescu/hisohiso
Live demo: https://hisohiso.org/
```

## Objection prep

Comments to expect within the first hour. Have a one-paragraph reply
ready for each — fast, specific, no marketing voice.

### "Why not just use the official Claude app?"

> Because the official app loses your terminal session and you can't tell
> why. Hisohiso has the daemon as a single source of truth: it's either
> reachable or your machine is the problem. You can also spawn a fresh
> agent in 2 seconds if one hangs — try doing that with a native app
> that won't reconnect.

### "Why not Telegram + a bot?"

> Because Telegram is a chat UI. There's no way for an agent to render a
> diff, a confirm-danger gate, a swipe-to-sort. Hisohiso has those as
> first-class block types in the message protocol.

### "How does the encryption work?" / "Can I trust the server?"

> Room secret lives in the URL hash fragment, so it never reaches the
> server or shows up in logs/Referer headers. Messages are AES-GCM
> encrypted in the browser before send. Server only routes the ciphertext.
> Server storage is room/token/presence metadata plus an opt-in
> 24h ciphertext outbox per room. Code is GPLv3 — read it.

### "What about my Claude auth?"

> Claude runs on your laptop with your existing `claude` CLI auth.
> Hisohiso never sees your Anthropic credentials. The CLI just streams
> text in and out of the `claude` process.

### "PWA on iOS, really?"

> Yes, supported since Safari 16.4. Install once via Share → Add to Home
> Screen. The PWA can receive web push if you opt in.

### "Multi-device, multi-room?"

> Yes. Message history is IndexedDB per device. Per-room opt-in 24h
> server-side encrypted outbox if you want devices to catch up after
> being offline.

### "Can I run my own server?"

> Yes — Docker Compose with FrankenPHP/Caddy/Mercure wiring is in the
> repo. Set a few env vars, one compose command. The CLI's
> `hisohiso server <url>` points the agent side at it.

### "Why GPLv3?"

> So forks stay open and the protocol stays inspectable. If you want a
> commercial-friendly license for a derivative, open an issue and we'll
> talk.

## After Show HN

Tweet thread (with the demo video) goes up within 30 minutes of the HN
submission, links back to the HN post.

r/ClaudeAI post the next day, casual tone, link to the HN thread and the
repo. Different opening — lead with the user moment, not the architecture.

Product Hunt last in the week (the first-comment draft already exists at
`ph-first-comment.md` in the repo root).
