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

Shipped today: **`hisohiso-blocks`** — the phone-UI block catalog plus
block-picking heuristics.

### Follow-ups (not in this change)

- **Trim `BLOCK_PROMPT`.** Today the full block catalog is force-fed every turn
  via `--append-system-prompt`. Once we've verified on-device that `claude -p`
  (non-interactive) reliably loads skills, the always-on preamble can shrink to
  the non-negotiable core (output one JSON object, act-first, security envelope)
  and defer the catalog to the `hisohiso-blocks` skill. The JSON output contract
  must stay in the preamble — skills are model-decided and one-shot / registered
  / non-Claude profiles have no skill loader.
- **Auto-install on `daemon install`** so the bundled skills land without a
  manual step.
