import { useState } from 'react';
import type { BeforeAfterBlock as BeforeAfterBlockType } from '../../lib/blocks';

interface Props {
  block: BeforeAfterBlockType;
}

export const BeforeAfterBlockView = ({ block }: Props) => {
  const [showAfter, setShowAfter] = useState(false);
  const side = showAfter ? block.after : block.before;

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-ink-soft bg-[#1b1b1b]">
      <div className="flex items-center justify-between border-b border-ink-soft px-4 py-2">
        {block.file && <span className="font-mono text-xs text-ink-soft">{block.file}</span>}
        <div className="flex overflow-hidden rounded-full border border-ink-soft">
          <button
            type="button"
            onClick={() => setShowAfter(false)}
            className={`px-3 py-1 text-xs font-medium ${!showAfter ? 'bg-ink text-on-ink' : 'text-ink-dim'}`}
          >
            {block.before.label}
          </button>
          <button
            type="button"
            onClick={() => setShowAfter(true)}
            className={`px-3 py-1 text-xs font-medium ${showAfter ? 'bg-ink text-on-ink' : 'text-ink-dim'}`}
          >
            {block.after.label}
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-5 text-ink-fade">
        {side.content}
      </pre>
    </div>
  );
};
