---
name: hisohiso-add-block-type
description: Add a new structured phone-UI block type to hisohiso end to end. Use when asked to add/extend a block (e.g. a new card, widget, or interactive element) the agent can emit and the phone renders.
---

# Adding a new block type

A block is emitted by the wrapped agent as JSON, sanitized by the CLI, validated
by the app, and drawn by a renderer. Adding one touches **four layers** — miss
one and the block silently drops or renders blank.

## The four touch points

1. **App renderer** — `app/src/components/blocks/<Name>Block.tsx`
   - New component. Register it in `app/src/components/blocks/BlockRenderer.tsx`
     (the `type` → component switch).
2. **App validation / types** — `app/src/lib/block-validation.ts` (and
   `app/src/lib/blocks.ts`)
   - Accept the new `type` and its fields; anything not validated is dropped.
3. **CLI sanitizer** — `cli/src/lib/agent-process.ts`
   - `extractCompleteBlocks` / `sanitizeBlocks` (the latter from
     `cli/src/lib/safe-href.ts`). Ensure the new type passes through and any URL
     fields go through the safe-href allowlist.
4. **Agent contract** — `cli/src/lib/preamble.ts` (`BLOCK_PROMPT`) **and** the
   bundled `hisohiso-blocks` skill (`cli/src/lib/skills/bundled.ts`)
   - Document the block's shape and when to use it, or the agent never emits it.

## Checklist

- [ ] Renderer component added and registered in `BlockRenderer.tsx`.
- [ ] Validation accepts the type + required fields (reject malformed).
- [ ] Interactive? give it an `id` and wire the response path.
- [ ] URL field? route it through the safe-href allowlist (no `javascript:`/`data:`/`file:`).
- [ ] Documented in `BLOCK_PROMPT` and the `hisohiso-blocks` skill, with a misuse note.
- [ ] Mobile-first: it must read well on a small screen.

## Why all four

The agent only emits blocks it's told about (layer 4). The CLI drops blocks it
doesn't pass through (layer 3). The app drops blocks it can't validate (layer 2)
or render (layer 1). The contract and the renderer must agree on field names.
