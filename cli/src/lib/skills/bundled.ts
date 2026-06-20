import { installSkills, type BundledSkill } from '../skill-sync.js';

// Canonical content for the skills hisohiso ships with the CLI. Inlined as
// strings (like DEFAULT_PREAMBLE / BLOCK_PROMPT in lib/preamble.ts) so the
// single compiled binary carries them with no resources dir. `hisohiso skills
// install` writes these into ~/.claude/skills, ~/.codex/skills and
// ~/.agents/skills, where the wrapped agent discovers them natively.
//
// hisohiso-blocks is the FULL block reference. The always-on preamble
// (BLOCK_PROMPT) keeps the JSON contract + a compact one-line shape per block;
// this skill carries the per-block JSON examples, the block-picker guide, and
// the complete misuse catalog, pulled in on demand when composing rich UI.

const HISOHISO_BLOCKS_SKILL = `---
name: hisohiso-blocks
description: Full reference for composing hisohiso phone-UI blocks — per-block JSON examples, a block-picker decision guide, and the misuse catalog. Load whenever you reply to a phone-bridged room with anything beyond a one-line answer.
---

# Composing hisohiso phone blocks

You are bridged to a phone over an end-to-end encrypted hisohiso room. Your reply
is rendered as touchscreen UI: a JSON object \`{ "text": "...", "blocks": [ ... ] }\`.
Compose the UX; don't narrate it. The always-on contract (output one raw JSON
object, act first, security envelope, the compact block list) is in your system
prompt — this skill is the depth: examples, the picker, and the misuses.

## Block-picker decision guide

- One- or two-sentence answer → \`text\` only, no blocks. The common case.
- A choice the user makes → \`buttons\` (2–4 options). Binary → \`buttons\`, never \`swipe\`.
- 3+ options each worth pros/cons, judged one at a time → \`swipe\`.
- "Here are the things" (static) → \`list\`. Interactive check/uncheck → \`checklist\`.
- Set a number on a scale → \`slider\`. Reorder/prioritize → \`sortable\`.
- File changes → \`diff\`. Several files touched → \`file-tree\`. Old-vs-new flip → \`before-after\`.
- Multi-step work whose status changes → \`progress\` (stable \`id\`, re-emit). A real code snippet → \`code\`.
- Command output → \`terminal\`. An error → \`error\`. Destructive action → \`confirm-danger\`. Commit → \`commit\`.
- Reasoning you want available but folded → \`thinking\`. Many results to browse → \`carousel\`.
- \`prose\` is the LAST resort — plain markdown, not a widget. If a structured block fits, use it.

Any block may carry \`confidence\` (high|medium|low), \`collapsed\`, and \`summary\`
(shown when collapsed). Interactive blocks must have an \`id\`.

## Decision & input blocks (user responds)

**buttons** — inline option buttons (2–4)
\`\`\`json
{"type": "buttons", "id": "pick-x", "prompt": "Question?", "options": [{"label": "A", "value": "a"}, {"label": "B", "value": "b"}], "multi": false}
\`\`\`
Set \`"multi": true\` to allow multiple selections.

**swipe** — card-by-card good/bad rating. Use only for 3+ cards each carrying pros/cons. Response is a map of \`{value: "good" | "bad"}\`.
\`\`\`json
{"type": "swipe", "id": "approach", "prompt": "Which to keep?", "cards": [{"value": "a", "title": "Title", "body": "Description", "pros": ["..."], "cons": ["..."]}]}
\`\`\`

**slider** — range/scale input
\`\`\`json
{"type": "slider", "id": "scope", "prompt": "How much refactoring?", "min": {"value": 0, "label": "None"}, "max": {"value": 100, "label": "Full rewrite"}, "default": 30}
\`\`\`

**checklist** — multi-select task list (interactive)
\`\`\`json
{"type": "checklist", "id": "tasks", "prompt": "Which tasks?", "items": [{"value": "x", "label": "Do X", "checked": true}], "confirm_label": "Go ahead"}
\`\`\`

**sortable** — drag to reorder / prioritize
\`\`\`json
{"type": "sortable", "id": "priority", "prompt": "Set priority:", "items": [{"value": "a", "label": "Bug A"}, {"value": "b", "label": "Bug B"}]}
\`\`\`

## Information display blocks (read-only)

**diff** — file changes
\`\`\`json
{"type": "diff", "file": "src/foo.ts", "language": "typescript", "hunks": [{"header": "@@ -1,3 +1,5 @@", "lines": [{"op": " ", "text": "context"}, {"op": "-", "text": "old"}, {"op": "+", "text": "new"}]}], "stats": {"additions": 1, "deletions": 1}}
\`\`\`

**file-tree** — affected files overview (status: added|modified|deleted|renamed)
\`\`\`json
{"type": "file-tree", "summary": "3 files changed", "nodes": [{"path": "src", "children": [{"path": "foo.ts", "status": "modified"}, {"path": "bar.ts", "status": "added"}]}]}
\`\`\`

**terminal** — command output
\`\`\`json
{"type": "terminal", "command": "npm test", "output": "PASS 8 tests", "exit_code": 0}
\`\`\`

**progress** — live multi-step tracker (status: done|active|pending|failed)
\`\`\`json
{"type": "progress", "id": "deploy-42", "title": "Migration", "steps": [{"label": "Analyze", "status": "done"}, {"label": "Migrate", "status": "active"}, {"label": "Verify", "status": "pending"}]}
\`\`\`
Include a stable \`id\` and re-emit the block with the same \`id\` as steps complete — the phone replaces the old snapshot everywhere. Without an \`id\` it freezes at send time.

**code** — syntax-highlighted snippet (code only — no word wrap, never use for prose)
\`\`\`json
{"type": "code", "file": "src/foo.ts", "language": "typescript", "start_line": 42, "content": "code here", "highlight_lines": [44]}
\`\`\`

**prose** — wrapped markdown (headings, bullets, bold/italic, inline code). LAST resort only.
\`\`\`json
{"type": "prose", "content": "## Findings\\n\\nThe regression appeared after **commit abc123**.\\n\\n- src/auth/login.ts\\n- src/auth/signup.ts"}
\`\`\`

**list** — immutable bullet/numbered/check list (style: bullet|numbered|check)
\`\`\`json
{"type": "list", "title": "Affected files", "style": "bullet", "items": ["src/auth/login.ts", "src/auth/signup.ts"]}
\`\`\`

**label** — small heading to group adjacent blocks
\`\`\`json
{"type": "label", "text": "Changed files"}
\`\`\`

**before-after** — flip between old/new (both keys required)
\`\`\`json
{"type": "before-after", "file": "src/foo.ts", "language": "typescript", "before": {"label": "Before", "content": "const x = getData();"}, "after": {"label": "After", "content": "const x = await getData();"}}
\`\`\`

**error** — error display
\`\`\`json
{"type": "error", "title": "TypeError: x is undefined", "file": "src/foo.ts", "line": 87, "stack": "...", "suggestion": "Add a null check"}
\`\`\`

## Confirmation & action blocks

**confirm-danger** — destructive gate (long-press)
\`\`\`json
{"type": "confirm-danger", "id": "force-push", "title": "Force push to main", "description": "This will overwrite 3 commits", "command": "git push --force origin main"}
\`\`\`

**commit** — commit message proposal
\`\`\`json
{"type": "commit", "id": "c1", "message": "Fix null ref in checkout\\n\\nAdd guard clause", "files": ["src/handler.ts"], "stats": {"additions": 5, "deletions": 2}}
\`\`\`

**run-command** — ask permission to run a command (risk: safe|moderate|dangerous)
\`\`\`json
{"type": "run-command", "id": "r1", "command": "npm test --coverage", "description": "Run tests", "risk": "safe"}
\`\`\`

## Feedback, status & navigation blocks

**thinking** — collapsible reasoning (collapsed by default)
\`\`\`json
{"type": "thinking", "summary": "Analyzed 12 files", "content": "First I checked..."}
\`\`\`

**cost** — token usage badge
\`\`\`json
{"type": "cost", "total_tokens": 15000, "estimated_cost": 0.05}
\`\`\`

**file-peek** — inline file preview
\`\`\`json
{"type": "file-peek", "file": "src/foo.ts", "language": "typescript", "start_line": 1, "content": "first lines...", "total_lines": 142}
\`\`\`

**carousel** — horizontal swipeable results
\`\`\`json
{"type": "carousel", "title": "Found 4 matches", "cards": [{"title": "src/foo.ts", "subtitle": "Line 87", "preview": "matching code", "meta": "Modified 2d ago"}]}
\`\`\`

**link-preview** — rich URL card
\`\`\`json
{"type": "link-preview", "url": "https://...", "title": "Page Title", "description": "Description", "domain": "example.com"}
\`\`\`

**swatches** — color chips rendered from hex; one or more named schemes for showing palette variations side by side. Only literal hex (#rgb / #rgba / #rrggbb / #rrggbbaa) renders — any other value is dropped.
\`\`\`json
{"type": "swatches", "title": "Toned-down palette", "schemes": [{"name": "Dusty Pop", "note": "~30% less chroma", "colors": [{"hex": "#e0728f", "name": "pink"}, {"hex": "#6470cf", "name": "blue"}, {"hex": "#abc55a", "name": "lime"}]}]}
\`\`\`

**secret** — masked input for ONE sensitive value (password, token, key) that you genuinely need to do the task. The user types it behind a password field; on submit the value is sent to you over the encrypted channel. It is masked everywhere else: chat history, the message preview, and daemon logs all show \`••••••\`, and it is never written to the device's local history.
\`\`\`json
{"type": "secret", "id": "gh-token", "prompt": "Paste a GitHub token with repo scope", "placeholder": "ghp_…"}
\`\`\`
Security rules: request a secret ONLY when the task truly requires it; ask for the narrowest-scoped credential possible; and NEVER echo the received value back — not in a reply, a \`code\`/\`terminal\` block, a commit, or a command you ask to run. The masking protects history and logs, not a value you paste back yourself.

## Common misuses to avoid

- ❌ Prose/report in \`code\` (no word wrap) — use \`prose\`/\`list\`/\`text\`.
- ❌ An explanation or summary wrapped in \`prose\` to look structured — \`prose\` is markdown, not a widget. Short answers go in \`text\`; structured content in the matching block.
- ❌ \`checklist\` for a non-interactive list — use \`list\`.
- ❌ \`progress\` for a static list, or without an \`id\` then a later "step 2 done" message — the snapshot goes stale. Always include an \`id\` and re-emit.
- ❌ \`swipe\` for a binary choice — use \`buttons\`.
- ❌ \`javascript:\`/\`data:\`/\`file:\` URLs in \`link-preview\` — blocked by the renderer and logged.

## Where this is implemented

Renderers: \`app/src/components/blocks/\` (registered in \`BlockRenderer.tsx\`).
Wire validation: \`app/src/lib/block-validation.ts\`. CLI sanitize: \`cli/src/lib/agent-process.ts\`.
To add a NEW block type, follow the \`hisohiso-add-block-type\` skill.
`;

export const BUNDLED_SKILLS: readonly BundledSkill[] = [
  { name: 'hisohiso-blocks', files: { 'SKILL.md': HISOHISO_BLOCKS_SKILL } },
];

/**
 * Idempotently install the bundled skills wherever a wrapped agent is about to
 * run (daemon start/install, wrap). Silent on no-op, non-fatal on error — a
 * read-only HOME must never block the daemon or a wrap session. Because the
 * sync only writes on change, this also self-heals after a CLI auto-update.
 */
export const ensureBundledSkills = async (): Promise<void> => {
  try {
    const { changedFiles } = await installSkills(BUNDLED_SKILLS);
    if (changedFiles > 0) {
      const names = BUNDLED_SKILLS.map((s) => s.name).join(', ');
      console.log(`Installed agent skills (${names}) into ~/.claude, ~/.codex, ~/.agents.`);
    }
  } catch (err) {
    console.error(
      `Note: could not install bundled agent skills (${(err as Error).message}). Continuing.`,
    );
  }
};
