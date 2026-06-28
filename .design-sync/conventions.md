# hisohiso — building with this design system

hisohiso is a **phone-first chat surface for coding agents**: an agent talks to a human in a room, and structured "blocks" carry diffs, commands, progress, questions, and reasoning. The look is a warm-paper "riso" aesthetic — soft paper background, ink text, a pink accent, Bricolage Grotesque for display and Space Mono for code.

## Setup & wrapping
- **No provider or context is required** to render the message blocks — import and render them directly. They are presentational, driven entirely by props.
- Components are React 18 function components exposed on `window.Hisohiso.*`. Default-exported app pieces (`Avatar`, `RoomCard`, `RoomsRail`, …) are re-exported as **named** exports, so `import { Avatar } from 'hisohiso-app'` works.
- For a full app screen, wrap content in the shell class **`app-chrome`** (or `app-page app-chrome`) to get the paper background and safe-area chrome.
- **Dark mode**: add `class="dark"` to a root ancestor — every token below flips to the warm-console dark palette automatically. No prop needed.

## The styling idiom — Tailwind utilities over CSS-variable tokens
Style with Tailwind utility classes whose colors map to the design tokens. **Do not invent hex values** — use the token classes so light/dark and brand stay correct. The token color family (use as `bg-*`, `text-*`, `border-*`):

| Class root | Role |
|---|---|
| `bg`, `surface` | page paper / raised surface |
| `ink`, `ink-soft`, `ink-dim`, `ink-fade` | text, strong → faint |
| `rule`, `rule-soft` | hairline borders |
| `accent`, `accent-strong`, `accent-soft` | pink brand accent |
| `danger`, `danger-soft` | destructive |
| `filled`, `on-ink` | filled-button background / text on dark |
| `success`, `pink`, `blue`, `lime`, `tang` | status / decorative |

Examples: a surface `className="bg-surface text-ink border border-rule rounded-2xl"`; a primary button `className="bg-filled text-on-ink rounded-full"`; an accent pill `className="bg-accent-soft text-accent"`. Code/monospace uses **`font-mono`** (Space Mono); body and display text is Bricolage Grotesque by default (no class needed).

**Custom component classes** (already styled — just apply): `message-card` (a chat-message surface), `glass-panel`, `floating-action` (the compose CTA), `block-card` / `block-code` (a block container and its code area), `btn-ghost`, `command-bar`, `pill-control`, and `modal-frame` + `modal-shell` (overlay).

## Where the truth lives
- Tokens, the full class set, and the `@font-face` rules are in the bound **`styles.css`** (it `@import`s `_ds_bundle.css` and `fonts/fonts.css`) — read it before styling.
- Each component's API is in its **`<Name>.d.ts`**; usage and examples are in its **`<Name>.prompt.md`**.

## One idiomatic example — an agent message
```tsx
import { BlockRenderer } from 'hisohiso-app';

<div className="message-card">
  <BlockRenderer
    onRespond={(responses) => submit(responses)}
    blocks={[
      { type: 'prose', id: 'p', content: 'Found the bug — a race in the poller. Fix:' },
      { type: 'diff', id: 'd', file: 'src/lib/presence.ts',
        stats: { additions: 2, deletions: 2 },
        hunks: [{ header: '@@ -40,4 +40,4 @@', lines: [
          { op: '-', text: 'timer = setInterval(poll, 1000);' },
          { op: '+', text: 'timer = setInterval(poll, POLL_MS);' } ] }] },
      { type: 'buttons', id: 'b', prompt: 'Apply and re-run?',
        options: [{ label: 'Apply & run', value: 'yes' }, { label: 'Hold', value: 'wait' }] },
    ]}
  />
</div>
```
Every block type also has a standalone `*BlockView` (e.g. `ButtonsBlockView`, `DiffBlockView`) if you need to place one directly rather than through `BlockRenderer`.
