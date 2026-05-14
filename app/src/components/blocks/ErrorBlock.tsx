import { useState } from 'react';
import type { ErrorBlock as ErrorBlockType } from '../../lib/blocks';

interface Props {
  block: ErrorBlockType;
}

export const ErrorBlockView = ({ block }: Props) => {
  const [stackOpen, setStackOpen] = useState(false);

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border-2 border-red-300 bg-[#fef5f3]">
      <div className="border-b border-red-200 px-4 py-3">
        <p className="font-mono text-sm font-bold text-red-800">{block.title}</p>
        {block.file && (
          <p className="mt-1 font-mono text-xs text-red-600">
            {block.file}{block.line != null && `:${block.line}`}
          </p>
        )}
      </div>
      {block.stack && (
        <div className="border-b border-red-200">
          <button
            type="button"
            onClick={() => setStackOpen(!stackOpen)}
            className="w-full px-4 py-2 text-left text-xs font-semibold text-red-600"
          >
            {stackOpen ? '▾' : '▸'} Stack trace
          </button>
          {stackOpen && (
            <pre className="max-h-40 overflow-auto px-4 pb-3 font-mono text-[12px] leading-5 text-red-700">
              {block.stack}
            </pre>
          )}
        </div>
      )}
      {block.suggestion && (
        <div className="flex gap-2 px-4 py-3">
          <span className="shrink-0 text-base">&#128161;</span>
          <p className="text-sm leading-6 text-[#3f3529]">{block.suggestion}</p>
        </div>
      )}
    </div>
  );
};
