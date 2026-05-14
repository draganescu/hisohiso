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
        className="flex w-full items-center gap-2 rounded-xl border border-[#e8e0d0] bg-[#f9f5ee] px-4 py-2.5 text-left"
      >
        <span className="text-base">&#129504;</span>
        <span className="flex-1 text-sm text-[#6a5e4e]">{block.summary || 'Reasoning'}</span>
        <span className="text-xs text-[#8d816c]">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="mt-1 rounded-xl border border-[#e8e0d0] bg-[#f9f5ee] px-4 py-3">
          <p className="whitespace-pre-wrap text-sm leading-6 text-[#5d564d]">{block.content}</p>
        </div>
      )}
    </div>
  );
};
