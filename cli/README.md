# hisohiso CLI

Bridge a terminal AI agent on your laptop or server to your phone over the
same end-to-end encrypted channel the web app uses. You run the agent in a
shell; the agent's output streams to a hisohiso room on your phone; what you
type back from your phone goes into the agent's stdin.

> **Supported agent: Claude (Anthropic Claude Code) only, for now.**
>
> The CLI ships built-in profiles for a few other tools (aider, codex, goose,
> bash, python), and they may work, but Claude is the one we actually use and
> support. Block rendering, multi-turn sessions, and prompt tuning all target
> Claude. Treat the others as experimental until further notice.

## Install

Pre-built binaries are published with every release tag (darwin arm64/x64,
linux arm64/x64). The install script grabs the one for your machine and
drops it in `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/draganescu/hisohiso/main/cli/install.sh | sh
```

Then either start a new shell or `source` your rc file so `~/.local/bin` is
on `PATH`. Confirm with:

```sh
hisohiso --version
```

You also need the Claude CLI installed and authenticated on the same machine:

```sh
# https://docs.anthropic.com/en/docs/claude-code
claude --version
```

## Quick start — wrap mode

`wrap` is the simplest way to use the CLI. It creates a one-off encrypted room,
shows a QR code, and bridges Claude to whoever joins.

```sh
hisohiso wrap claude
```

1. Scan the QR on your phone (or open the printed URL).
2. The browser opens a room; tap **Knock** to join. The CLI auto-approves.
3. Anything you send from the phone goes to Claude as a prompt; Claude's
   reply streams back into the room.

`Ctrl+C` on the CLI disbands the room and exits.

## Daemon mode

Wrap is one-room-at-a-time. The daemon keeps a persistent **control room** open
that you can talk to from your phone to spawn agent sessions on demand without
returning to the laptop.

```sh
hisohiso daemon start    # foreground; shows QR on first run
hisohiso daemon status
hisohiso daemon stop
```

Once your phone is paired with the control room, send commands from the room
chat:

| Phone message    | Effect                                                   |
| ---------------- | -------------------------------------------------------- |
| `claude`         | Spawn a Claude session in its own room, get a join link  |
| `list`           | List currently running agent rooms                       |
| `kill <agent-id>`| Stop a running agent session                             |
| `help`           | Show available commands                                  |

Daemon rooms (the control room + every spawned agent room) are created with
**offline catch-up on**, so the phone sees messages emitted while the app was
closed (the server stores ciphertext only, capped at 500 messages / 24h per
room — see the [main README](../README.md#offline-catch-up-opt-in)).

### Registering custom agents

If you want to expose another tool through the daemon, register a shell
command. The agent name is what you'll type on the phone to spawn it.

```sh
hisohiso daemon register myagent --command "my-tool --some-flag"
hisohiso daemon list
hisohiso daemon unregister myagent
```

The registered command receives the phone's message as its final argument.
This works for any agent CLI that takes a single prompt arg — but again, only
Claude is officially supported; quality of life for other agents (block
rendering, multi-turn, error handling) may vary.

## Configuration

By default the CLI talks to `hisohiso.org`. To run against your own deployment:

```sh
hisohiso server https://your-hisohiso.example.com
```

The server URL is stored in `~/.config/hisohiso/config.json`. Daemon state
(active rooms, registered agents) also lives in that directory.

## Built-in agent profiles

`hisohiso agents` prints them at runtime, but for reference:

| Name           | Mode    | Description                                        |
| -------------- | ------- | -------------------------------------------------- |
| `claude`       | session | Claude Code, multi-turn (`--resume` between msgs)  |
| `claude-once`  | oneshot | Claude Code, single question each time             |
| `aider`        | oneshot | Aider (AI pair programming) — experimental         |
| `codex`        | oneshot | Codex CLI (OpenAI) — experimental                  |
| `goose`        | oneshot | Goose (Block) — experimental                       |
| `bash`         | oneshot | Run shell commands via `bash -c <msg>`             |
| `python`       | oneshot | Run Python via `python3 -c <msg>`                  |

Again: `claude` is the supported one. The others ship for tinkering.

## Releases

The CLI is versioned with git tags (e.g. `v0.3.6`). `install.sh` downloads
from `releases/latest/download/`, so a **GitHub Release with assets** has to
exist for the tag — a plain `git tag` is not enough.

The release flow:

```sh
cd cli
bun run build:all                       # rebuild all four binaries
git add -f dist/hisohiso-*              # binaries are .gitignored; force-add
git commit -m "Build CLI v0.3.7 binaries"
git tag v0.3.7
git push origin main v0.3.7
bun run release v0.3.7                  # creates the GitHub Release + assets
```

`bun run release` calls `scripts/release.sh` which verifies the binaries
exist, the tag exists locally and on origin, `gh` is authenticated, and
the release doesn't already exist. Custom notes:

```sh
RELEASE_NOTES="Fixes #42; adds X" bun run release v0.3.7
```

## Source

Source lives under `cli/` in this repo. To run from source:

```sh
cd cli
bun install            # or: npm install
bun run dev wrap claude
```

The build script (`bun run build:all`) produces the four release binaries.
