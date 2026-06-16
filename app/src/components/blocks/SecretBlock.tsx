import { useState } from 'react';
import type { SecretBlock as SecretBlockType } from '../../lib/blocks';

interface Props {
  block: SecretBlockType;
  onSelect: (blockId: string, type: string, value: string) => void;
  submitted: boolean;
}

// Masked entry for a secret the agent asked for (e.g. a token or password).
// On submit the value is handed to the renderer, which auto-sends it (see
// isAutoSubmit) so it never sits in the shared pending-selection map. The value
// travels only inside the encrypted block_responses to the agent; it is masked
// in chat history and daemon logs. The agent process itself does see it.
export const SecretBlockView = ({ block, onSelect, submitted }: Props) => {
  const [value, setValue] = useState('');
  const [revealed, setRevealed] = useState(false);

  if (submitted) {
    return (
      <div className="mt-3 rounded-2xl border border-rule bg-surface px-4 py-3">
        <p className="text-sm font-semibold text-ink">{block.prompt}</p>
        <p className="mt-1 text-[0.8125rem] text-ink-soft">🔒 Secret sent to the agent — not saved to this chat.</p>
      </div>
    );
  }

  const submit = () => {
    const v = value;
    if (!v) return;
    setValue('');
    setRevealed(false);
    onSelect(block.id, 'secret', v);
  };

  return (
    <div className="mt-3 rounded-2xl border border-rule bg-surface px-4 py-3">
      <p className="text-sm font-semibold text-ink">{block.prompt}</p>
      <div className="mt-2 flex items-stretch gap-2">
        <input
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder={block.placeholder || 'Enter secret…'}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-xl border border-ink-fade bg-bg px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          aria-label={revealed ? 'hide secret' : 'reveal secret'}
          aria-pressed={revealed}
          className="shrink-0 rounded-xl border border-ink-fade bg-surface px-3 text-xs font-medium text-ink-soft active:bg-bg"
        >
          {revealed ? 'hide' : 'show'}
        </button>
      </div>
      <button
        type="button"
        onClick={submit}
        disabled={!value}
        className="mt-2 w-full rounded-full bg-filled py-2.5 text-sm font-semibold text-on-ink disabled:opacity-40"
      >
        {block.confirm_label || 'Send securely'}
      </button>
      <p className="mt-2 text-[0.6875rem] leading-tight text-ink-dim">
        Sent encrypted, directly to the agent. Masked in chat history and logs — but the agent will see the value, so only enter what it needs.
      </p>
    </div>
  );
};
