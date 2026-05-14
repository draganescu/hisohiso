import { useState } from 'react';
import type { BeforeAfterBlock as BeforeAfterBlockType } from '../../lib/blocks';

interface Props {
  block: BeforeAfterBlockType;
}

export const BeforeAfterBlockView = ({ block }: Props) => {
  const [showAfter, setShowAfter] = useState(false);
  const side = showAfter ? block.after : block.before;

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-[#333] bg-[#1b1b1b]">
      <div className="flex items-center justify-between border-b border-[#333] px-4 py-2">
        {block.file && <span className="font-mono text-xs text-[#e0d8c8]">{block.file}</span>}
        <div className="flex overflow-hidden rounded-full border border-[#555]">
          <button
            type="button"
            onClick={() => setShowAfter(false)}
            className={`px-3 py-1 text-xs font-medium ${!showAfter ? 'bg-[#d9592f] text-white' : 'text-[#888]'}`}
          >
            {block.before.label}
          </button>
          <button
            type="button"
            onClick={() => setShowAfter(true)}
            className={`px-3 py-1 text-xs font-medium ${showAfter ? 'bg-[#d9592f] text-white' : 'text-[#888]'}`}
          >
            {block.after.label}
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-5 text-[#ccc]">
        {side.content}
      </pre>
    </div>
  );
};
