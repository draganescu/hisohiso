import type { BundledSkill } from '../skill-sync.js';

// Canonical content for the skills hisohiso ships with the CLI. Inlined as
// strings (like DEFAULT_PREAMBLE / BLOCK_PROMPT in lib/preamble.ts) so the
// single compiled binary carries them with no resources dir. `hisohiso skills
// install` writes these into ~/.claude/skills, ~/.codex/skills and
// ~/.agents/skills, where the wrapped agent discovers them natively.

const HISOHISO_BLOCKS_SKILL = `---
name: hisohiso-blocks
description: Reference for composing hisohiso phone-UI blocks. Load when you are about to reply to a phone-bridged room and want to pick the right structured block (diff, buttons, progress, list, …) instead of dumping prose.
---

# Composing hisohiso phone blocks

You are bridged to a phone over an end-to-end encrypted hisohiso room. Your
reply is rendered as touchscreen UI: a JSON object \`{ "text": "...", "blocks": [ ... ] }\`.
Your job is to **compose the UX**, not narrate it. This skill is the catalog and
the picking heuristics; the always-on contract (output one raw JSON object, act
first, security envelope) lives in your system prompt.

## Pick-the-block heuristics

- One- or two-sentence answer → \`text\` only, no blocks. This is the common case.
- A real choice the user makes → \`buttons\` (2–4 options). Binary → \`buttons\`, never \`swipe\`.
- 3+ options each worth pros/cons judged one at a time → \`swipe\`.
- "Here are the things" (static) → \`list\`. Interactive check/uncheck → \`checklist\`.
- File changes → \`diff\`. Several files touched → \`file-tree\`. Old-vs-new flip → \`before-after\`.
- Multi-step work whose status changes over time → \`progress\` (always with a stable \`id\`; re-emit it).
- Command output → \`terminal\`. An actual code snippet → \`code\` (never for prose — no word wrap).
- An error → \`error\`. A destructive action → \`confirm-danger\`. A commit proposal → \`commit\`.
- \`prose\` is the LAST resort — it is plain markdown, not a widget. If a structured block fits, use it.

## Block reference (abridged)

Interactive blocks need an \`id\`. Any block may carry \`confidence\`, \`collapsed\`, \`summary\`.

- **buttons** \`{type,id,prompt,options:[{label,value}],multi?}\`
- **swipe** \`{type,id,prompt,cards:[{value,title,body,pros[],cons[]}]}\`
- **slider** \`{type,id,prompt,min:{value,label},max:{value,label},default}\`
- **checklist** \`{type,id,prompt,items:[{value,label,checked}],confirm_label}\`
- **sortable** \`{type,id,prompt,items:[{value,label}]}\`
- **diff** \`{type,file,language,hunks:[{header,lines:[{op,text}]}],stats}\`
- **file-tree** \`{type,summary,nodes:[{path,children?|status}]}\` — status: added|modified|deleted|renamed
- **terminal** \`{type,command,output,exit_code}\`
- **progress** \`{type,id,title,steps:[{label,status}]}\` — status: done|active|pending|failed; re-emit with same id
- **code** \`{type,file,language,start_line,content,highlight_lines}\`
- **prose** \`{type,content}\` — markdown; last resort
- **list** \`{type,title,style,items[]}\` — style: bullet|numbered|check
- **label** \`{type,text}\` — group adjacent blocks under one heading
- **before-after** \`{type,file,language,before:{label,content},after:{label,content}}\` — both required
- **error** \`{type,title,file,line,stack,suggestion}\`
- **confirm-danger** \`{type,id,title,description,command}\`
- **commit** \`{type,id,message,files[],stats}\`
- **run-command** \`{type,id,command,description,risk}\` — risk: safe|moderate|dangerous
- **thinking** \`{type,summary,content}\` — collapsed by default
- **cost** \`{type,total_tokens,estimated_cost}\`
- **file-peek** \`{type,file,language,start_line,content,total_lines}\`
- **carousel** \`{type,title,cards:[{title,subtitle,preview,meta}]}\`
- **link-preview** \`{type,url,title,description,domain}\`

The renderers for these live in \`app/src/components/blocks/\`; the wire contract
is validated in \`app/src/lib/block-validation.ts\` and sanitized CLI-side in
\`cli/src/lib/agent-process.ts\`. To add a NEW block type, see the
\`hisohiso-add-block-type\` skill.

## Common misuses

- ❌ Prose/report in \`code\` (no wrap) or in \`prose\` to look structured — use \`text\`/\`list\`.
- ❌ \`checklist\` for a non-interactive list — use \`list\`.
- ❌ \`progress\` for a static list, or without an \`id\` then "step 2 done" — the snapshot goes stale.
- ❌ \`swipe\` for a binary choice — use \`buttons\`.
- ❌ Putting \`javascript:\`/\`data:\`/\`file:\` URLs in \`link-preview\` — blocked and logged.
`;

export const BUNDLED_SKILLS: readonly BundledSkill[] = [
  { name: 'hisohiso-blocks', files: { 'SKILL.md': HISOHISO_BLOCKS_SKILL } },
];
