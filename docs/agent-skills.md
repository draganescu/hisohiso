# Agent skills

hisohiso wraps a *real* agent binary (`claude` / `codex`) in the operator's
working directory — it doesn't reimplement one. So those agents already discover
[skills](https://docs.anthropic.com/en/docs/claude-code/skills) natively from
their standard skill directories. hisohiso leans on that instead of inventing a
new mechanism. There are two delivery paths.

## 1. Repo-committed dev skills (`.claude/skills/`)

Skills for working **on hisohiso itself**. They're version-controlled and load
automatically for any agent run inside this repo:

| Skill | Purpose |
| --- | --- |
| `hisohiso-release-cli` | Cut a CLI release (4 binaries, tag, GitHub Release with assets). |
| `hisohiso-dev-stack` | Run the stack locally, run tests, run the CLI from source. |
| `hisohiso-add-block-type` | The four layers to touch when adding a phone-UI block. |
| `hisohiso-crypto` | Reference for the E2E protocol (KDF, handshake, AAD, auth). |

> `.claude/` is otherwise gitignored; `.gitignore` carries a scoped exception so
> only `.claude/skills/` is tracked (local `settings.local.json` stays ignored).

## 2. Bundled skills shipped with the CLI

Skills for the **wrapped agent on the phone bridge**. Their content is inlined in
`cli/src/lib/skills/bundled.ts` (the single compiled binary carries no resources
dir — same pattern as the inline preamble in `cli/src/lib/preamble.ts`).

`hisohiso skills install` writes them into `~/.claude/skills`, `~/.codex/skills`,
and `~/.agents/skills`, where the wrapped agent finds them natively. The sync is
idempotent and manifest-tracked (`.hisohiso-managed-files.json`), so it never
clobbers operator edits and prunes only files it wrote.

```sh
hisohiso skills install     # install/update into the three skill dirs
hisohiso skills status      # not-installed | up-to-date | drift
hisohiso skills uninstall   # remove them again
```

Shipped: **`hisohiso-blocks`** — the full phone-UI block reference (per-block
JSON examples, a block-picker guide, and the misuse catalog).

## Always-on core vs. on-demand catalog

`BLOCK_PROMPT` (appended to the wrapped agent's system prompt every turn) is
trimmed to the **non-negotiable core**: the JSON output contract, act-first
behavior, input handling, the security envelope, and a **compact one-line shape
for every block**. The verbose per-block examples, the picker guide, and the
misuse catalog live in the `hisohiso-blocks` skill and are pulled in on demand.

Why keep a compact shape inline rather than defer everything: skills are
model-decided, and one-shot / registered / non-Claude profiles have no skill
loader. The inline shapes guarantee the agent can emit any block even if the
skill isn't loaded; the skill adds depth (examples, heuristics) for rich UI.
The JSON output contract therefore must never move out of the preamble.

### Follow-up (not in this change)

- **Auto-install on `daemon install`** so the bundled skills land without a
  manual `hisohiso skills install`.
