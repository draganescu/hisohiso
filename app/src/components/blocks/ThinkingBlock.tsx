import { useState } from 'react';
import type { ThinkingBlock as ThinkingBlockType } from '../../lib/blocks';

interface Props {
  block: ThinkingBlockType;
}

export const ThinkingBlockView = ({ block }: Props) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-xl border border-rule bg-bg px-4 py-2.5 text-left"
      >
        <span className="text-base">&#129504;</span>
        <span className="flex-1 text-sm text-ink-dim">{block.summary || 'Reasoning'}</span>
        <span className="text-xs text-ink-dim">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="mt-1 rounded-xl border border-rule bg-bg px-4 py-3">
          <p className="whitespace-pre-wrap text-sm leading-6 text-ink-soft">{block.content}</p>
        </div>
      )}
    </div>
  );
};
