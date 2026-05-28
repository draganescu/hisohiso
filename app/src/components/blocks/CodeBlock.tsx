import { useState } from 'react';
import type { CodeBlock as CodeBlockType } from '../../lib/blocks';

interface Props {
  block: CodeBlockType;
}

export const CodeBlockView = ({ block }: Props) => {
  const [copied, setCopied] = useState(false);
  const lines = block.content.split('\n');
  const startLine = block.start_line ?? 1;

  const copy = async () => {
    await navigator.clipboard.writeText(block.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-ink-soft bg-[#1b1b1b]">
      <div className="flex items-center justify-between border-b border-ink-soft px-4 py-2">
        <span className="font-mono text-xs text-ink-soft">
          {block.file && <>{block.file}</>}
          {block.file && block.start_line != null && (
            <span className="text-ink-dim">:{startLine}-{startLine + lines.length - 1}</span>
          )}
        </span>
        <button type="button" onClick={copy} className="text-xs text-ink-dim hover:text-on-ink">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="overflow-x-auto">
        {lines.map((line, i) => {
          const lineNum = startLine + i;
          const isHighlighted = block.highlight_lines?.includes(lineNum);
          return (
            <div
              key={i}
              className={`flex font-mono text-[13px] leading-5 ${isHighlighted ? 'bg-yellow-900/30' : ''}`}
            >
              <span className="w-12 shrink-0 select-none pr-3 text-right text-ink-soft">{lineNum}</span>
              <span className="whitespace-pre text-ink-fade">{line}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
