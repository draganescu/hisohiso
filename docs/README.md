# hisohiso docs

How the whole thing works, one piece at a time. These pages assume you can
read code and have shipped a web app before — they explain the *why* and the
shape of things, not every line.

If you read top to bottom you'll understand the system. If you're here for one
thing, jump to it.

| Page | What's in it |
| --- | --- |
| [overview.md](overview.md) | The mental model. What a "room" is, why the URL is the password, who can do what. Start here. |
| [encryption.md](encryption.md) | How messages stay private. Key derivation, and the knock → approve → join handshake that hands out a token without the server ever seeing it. |
| [server.md](server.md) | The PHP API. Every endpoint, the SQLite tables, and a precise list of what the server *can* and *can't* see. |
| [realtime.md](realtime.md) | How a message gets from one phone to another in real time. Mercure (SSE), the two per-room topics, and the JWTs that gate them. |
| [offline-catchup.md](offline-catchup.md) | The optional server-side outbox that lets a device catch up on messages it missed while closed. |
| [frontend.md](frontend.md) | The React app. The room state machine, where crypto happens, where history lives, and the PWA bits. |
| [cli.md](cli.md) | The `hisohiso` CLI — bridging a terminal AI agent to a room on your phone. wrap mode, the always-on daemon + its control plane, and the `update` / `uninstall` lifecycle. |
| [stack-and-server.md](stack-and-server.md) | **The stack and the recommended server setup.** What each piece is, why it's there, and how to run it in production. |
| [host-bootstrap.md](host-bootstrap.md) | The provisioning runbook — turning a fresh Linux box into a hardened hisohiso host. |
| [split-hosting.md](split-hosting.md) | Running the static marketing site and the app on **separate hosts** — apex content via pull hook, app subdomain via the app deploy workflow. |

## The one-paragraph version

hisohiso is an encrypted chat with no accounts. You make a room, you get a
link, you share the link. The link contains a secret that never leaves the
browser — the server only ever sees a hash of it. Messages are encrypted on
your device before they're sent; the server just routes the ciphertext to
whoever's in the room and forgets it. History lives on your devices, not in a
cloud. Anyone in a room can blow it up, and when they do, every device wipes
its copy.
