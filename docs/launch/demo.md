# Demo video shot list

Target: **45–60 seconds, no voiceover, on-screen captions only.**

This video is the launch. Embed it on the landing page, lead with it on
Twitter, link it from the Show HN first comment. Without this, the rest
of the launch material does 10% of the work it should.

## Setup before recording

- [ ] Clean macOS desktop. No personal Slack/Calendar visible.
- [ ] Terminal with a large font (16pt+). Use the same font in every shot.
- [ ] Phone in dark mode if you want, but pick one and stick to it.
- [ ] Wifi solid (the SSE connection going gray during the demo is a
      bad look).
- [ ] A safe demo branch with a known failing test and a small refactor
      task. The Claude prompts should resolve in ~10 seconds each so the
      video doesn't drag.
- [ ] Caption font: same family as the landing page (Space Grotesk).
      Captions go bottom-left, slight drop shadow.

## Shots

```
00:00–00:03   Caption: "Your AI agent runs on your laptop."
              Visual:  Laptop terminal. Type `hisohiso daemon start`.
                       QR code renders. Hold for one beat.

00:04–00:07   Caption: "You walk away from it."
              Visual:  Phone scans the QR. The PWA opens.
                       Control room joined. Show the empty room briefly.

00:08–00:12   Caption: "Spawn an agent from your phone."
              Visual:  Type `claude` in the phone composer. Send.
                       Daemon replies with a 'Join claude →' button block.
                       Tap it. New room opens.

00:13–00:19   Caption: "Send it real work."
              Visual:  Phone keyboard. Type:
                         fix the failing test on the staging branch
                       Send.

00:20–00:31   Caption: "Claude runs on your laptop. You watch from your phone."
              Visual:  Split screen.
                       Left: laptop terminal — Claude editing files, running tests.
                       Right: phone — output streams in as collapsed blocks.
                       Show a diff block expanding when tapped.

00:32–00:41   Caption: "Touch UI. Not a chat app."
              Visual:  Phone-only. Tap a buttons block ("merge" vs "don't").
                       Swipe a swipe block (A/B options). Expand a long
                       prose block. Hit a confirm-danger long-press gate.
                       Each interaction is one beat.

00:42–00:49   Caption: "Agent stuck? Kill it. Spawn a fresh one."
              Visual:  Back to control room on the phone.
                       Type `kill <id>`. Daemon confirms.
                       Type `claude` again. New session ready in 2 seconds.
                       This is the differentiated moment vs native apps.

00:50–00:55   Caption: "End-to-end encrypted. No accounts. Self-hostable."
              Visual:  Quick cut to GitHub repo page.
                       Then to the install.sh one-liner highlighted in
                       a terminal.

00:55–01:00   End card (static):
                hisohiso.org
                github.com/draganescu/hisohiso
                Built for Claude and Codex.
```

> **Foreground vs. always-on.** The opener uses `hisohiso daemon start` so the
> pairing QR renders on screen — best for the demo. In real use you'd usually
> `hisohiso daemon install` instead: a per-user background service (launchd /
> systemd) that survives reboots and restarts on crash, so "you walk away from
> it" is literal. Nothing visual to film there, so keep `daemon start` in the
> shot — just don't imply the laptop has to stay logged in with a terminal open.

## What NOT to show

- No "hello world" demos. Use a real task.
- No long pauses where the agent is thinking. Cut to the result.
- No mouse cursor on the phone side. Touch only.
- No notification banners on the phone (turn on Focus mode).
- No browser address bar visible on the PWA side. Phone should be
  installed-as-PWA mode.

## Variants

- **Twitter cut (45s)** — the version above.
- **HN cut (90s)** — same, plus 30s where you self-host: clone, env,
  compose up, point the CLI at the new server.
- **GIF (no audio, 12s)** — just the daemon → spawn → reply moment.
  Useful for embedding inline in HN comments.

## After recording

- [ ] Export 1080×1920 (vertical) for Twitter/Mastodon.
- [ ] Export 1920×1080 (horizontal) for HN/landing embed.
- [ ] Both should be under 30MB so they autoplay inline.
- [ ] Captions burned in (so it works muted on the timeline).
- [ ] Upload the horizontal version to the landing page hero. The
      Twitter version goes in the lead tweet of the launch thread.
