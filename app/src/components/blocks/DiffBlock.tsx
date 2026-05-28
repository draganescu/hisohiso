import { useState } from 'react';
import type { DiffBlock as DiffBlockType } from '../../lib/blocks';

interface Props {
  block: DiffBlockType;
}

export const DiffBlockView = ({ block }: Props) => {
  const [expandedHunks, setExpandedHunks] = useState<Set<number>>(new Set([0]));

  const toggleHunk = (idx: number) => {
    setExpandedHunks((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-ink-fade bg-[#1b1b1b]">
      <div className="flex items-center justify-between border-b border-ink-soft px-4 py-2.5">
        <span className="font-mono text-sm text-ink-soft">{block.file}</span>
        {block.stats && (
          <span className="flex gap-2 text-xs font-semibold">
            <span className="text-green-400">+{block.stats.additions}</span>
            <span className="text-red-400">-{block.stats.deletions}</span>
          </span>
        )}
      </div>
      {block.hunks.map((hunk, hi) => (
        <div key={hi}>
          <button
            type="button"
            onClick={() => toggleHunk(hi)}
            className="w-full border-b border-ink-soft bg-[#252525] px-4 py-1.5 text-left font-mono text-xs text-ink-dim"
          >
            {expandedHunks.has(hi) ? '▾' : '▸'} {hunk.header}
          </button>
          {expandedHunks.has(hi) && (
            <div className="overflow-x-auto">
              {hunk.lines.map((line, li) => (
                <div
                  key={li}
                  className={`whitespace-pre px-4 py-0.5 font-mono text-[13px] leading-5 ${
                    line.op === '+'
                      ? 'bg-[#1a2e1a] text-green-300'
                      : line.op === '-'
                      ? 'bg-[#2e1a1a] text-red-300'
                      : 'text-ink-fade'
                  }`}
                >
                  <span className="mr-2 inline-block w-4 text-center text-ink-dim">{line.op}</span>
                  {line.text}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
