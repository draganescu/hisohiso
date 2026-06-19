# hisohiso CLI

Bridge a terminal AI agent on your laptop or server to your phone over the
same end-to-end encrypted channel the web app uses. You run the agent in a
shell; the agent's output streams to a hisohiso room on your phone; what you
type back from your phone goes into the agent's stdin.

> **Supported agents: Claude (Anthropic Claude Code) and Codex (OpenAI).**
>
> Both run as multi-turn sessions with structured-block rendering (the same
> phone UI for diffs, buttons, confirm dialogs, etc.). Need something else?
> Register any single-prompt CLI as a custom agent — see
> [Registering custom agents](#registering-custom-agents) below.
>
> The daemon only offers agents whose command is actually installed on the
> host, so the phone launcher never lists something that would fail to start.

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

You also need the agent CLI you want to wrap installed and authenticated on
the same machine. hisohiso assumes the wrapped agent is fully set up — it
does not install agents, configure API keys, or run login flows.

```sh
# Claude — https://docs.anthropic.com/en/docs/claude-code
claude --version

# Codex — https://developers.openai.com/codex/cli
codex --version
```

## Update

The daemon auto-updates on a 6-hour tick, but you can update on demand — handy
for `wrap`/one-shot users (no daemon running) or right before a breaking release:

```sh
hisohiso update          # download the latest release, verify its checksum, swap the binary
hisohiso update --check  # just report current vs latest; download nothing
```

`update` downloads the matching-arch binary from the latest GitHub Release,
verifies it against the published `checksums.txt`, and atomically replaces the
on-disk binary. If a daemon is running it keeps its current process until you
restart it (or its next tick). It runs even with `HISOHISO_AUTO_UPDATE=off`,
which only silences the background tick.

## Uninstall

```sh
hisohiso uninstall            # stop daemon + service, remove the binary, keep ~/.hisohiso
hisohiso uninstall --clean    # also remove ~/.hisohiso and the installer's PATH block
hisohiso uninstall --dry-run  # show exactly what would be removed, change nothing
hisohiso uninstall --yes      # skip the confirmation prompt (for scripts)
```

`--clean` is destructive and confirms by default. It removes only what hisohiso
owns: the running binary, `~/.hisohiso`, files listed in a hisohiso-written
manifest (`~/.hisohiso/created-files.json`), and the managed PATH block the
installer wrote to your shell rc — never arbitrary name-matched files.

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

### Always on (background service)

`daemon start` runs in the foreground. To keep the control room alive across
logout and reboot — and restart it on crash — install it as a per-user
background service (launchd on macOS, a systemd user unit on Linux):

```sh
hisohiso daemon install     # pairs inline if needed, then installs + starts the service
hisohiso daemon uninstall   # stop + remove the service (keeps your local state)
```

It never runs as root, carries your `PATH` so the backgrounded daemon can still
find the wrapped agent CLIs, and logs to `~/.hisohiso/logs/daemon.log`.

### Managing a running daemon

These talk to the running daemon over an owner-only local control socket, and
degrade gracefully when it's down:

```sh
hisohiso info          # one-screen overview: paths, config, pairing, rooms, service — works when down
hisohiso status        # control room, running agents, devices awaiting admission
hisohiso pair          # re-render the QR + pairing code (e.g. to add another phone)
hisohiso admit [id]    # admit a device waiting to join the control room
hisohiso deny [id]     # deny a waiting device
hisohiso repair        # clean slate: disband all rooms and re-pair from scratch
hisohiso server <url>  # migrate a running daemon to a new server (disband + re-pair)
```

### Registering custom agents

If you want to expose another tool through the daemon, register a shell
command. The agent name is what you'll type on the phone to spawn it.

```sh
hisohiso daemon register myagent --command "my-tool --some-flag"
hisohiso daemon list
hisohiso daemon unregister myagent
```

The registered command receives the phone's message as its final argument.
This works for any agent CLI that takes a single prompt arg — but registered
agents don't get the structured-block UI or multi-turn session handling that
the built-in `claude` / `codex` profiles do; they're a thin shim for ad-hoc
tools.

## Configuration

By default the CLI talks to `hisohiso.org`. To run against your own deployment:

```sh
hisohiso server https://your-hisohiso.example.com
```

The server URL is stored in `~/.hisohiso/config.json`. Daemon state (pairing,
active rooms, registered agents, logs) also lives under `~/.hisohiso`. Set
`HISOHISO_HOME` to point at a different state directory — handy for running an
isolated second daemon alongside your main one.

## Built-in agent profiles

`hisohiso agents` prints them at runtime, but for reference:

| Name           | Mode    | Description                                        |
| -------------- | ------- | -------------------------------------------------- |
| `claude`       | session | Claude Code, multi-turn (`--resume` between msgs)  |
| `codex`        | session | Codex CLI (OpenAI), multi-turn (`exec resume`)     |

`claude` and `codex` are the two first-class agents. Anything else is a
[custom agent](#registering-custom-agents) you register yourself. A profile is
only offered (in `wrap` and on the phone launcher) when its command is actually
installed on the host.

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
