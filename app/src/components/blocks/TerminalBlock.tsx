import { useState } from 'react';
import type { TerminalBlock as TerminalBlockType } from '../../lib/blocks';

interface Props {
  block: TerminalBlockType;
}

export const TerminalBlockView = ({ block }: Props) => {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(block.output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const success = block.exit_code === 0;
  const accentBar = block.exit_code == null ? 'border-l-[#555]' : success ? 'border-l-green-500' : 'border-l-red-500';

  return (
    <div className={`mt-3 overflow-hidden rounded-2xl border border-ink-soft bg-[#1b1b1b] border-l-4 ${accentBar}`}>
      <div className="flex items-center justify-between border-b border-ink-soft px-4 py-2">
        <span className="font-mono text-xs text-ink-dim">$ {block.command}</span>
        <button
          type="button"
          onClick={copy}
          className="text-xs text-ink-dim hover:text-on-ink"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="max-h-60 overflow-auto p-4 font-mono text-[0.8125rem] leading-5 text-ink-fade">
        {block.output}
      </pre>
      {block.exit_code != null && (
        <div className={`border-t border-ink-soft px-4 py-1.5 text-right font-mono text-xs ${success ? 'text-green-400' : 'text-red-400'}`}>
          exit {block.exit_code}
        </div>
      )}
    </div>
  );
};
