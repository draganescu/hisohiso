# Dev skills (`.claude/skills/`)

Agent skills for working **on hisohiso itself**. They're version-controlled and
load automatically for any agent (Claude Code) run inside this repo — hisohiso
wraps a real agent binary, so it discovers
[skills](https://docs.anthropic.com/en/docs/claude-code/skills) natively from
`.claude/skills/` with no extra mechanism.

| Skill | Purpose |
| --- | --- |
| `hisohiso-release-cli` | Cut a CLI release (4 binaries, tag, GitHub Release with assets). |
| `hisohiso-dev-stack` | Run the stack locally, run tests, run the CLI from source. |
| `hisohiso-add-block-type` | The four layers to touch when adding a phone-UI block. |
| `hisohiso-crypto` | Reference for the E2E protocol (KDF, handshake, AAD, auth). |

> `.claude/` is otherwise gitignored; `.gitignore` carries a scoped exception so
> only `.claude/skills/` is tracked (local `settings.local.json` stays ignored).
