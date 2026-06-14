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
  // Riso-inked status edge: lime on success, tang on failure, neutral while running.
  const accentColor =
    block.exit_code == null ? 'var(--ink-fade)' : success ? 'var(--code-add)' : 'var(--code-del)';

  return (
    <div
      className="block-card block-code mt-3 rounded-2xl border-l-4"
      style={{ borderLeftColor: accentColor }}
    >
      <div className="block-code-rule flex items-center justify-between border-b px-4 py-2">
        <span className="font-mono text-xs" style={{ color: 'var(--code-ink)', opacity: 0.78 }}>
          $ {block.command}
        </span>
        <button
          type="button"
          onClick={copy}
          className="text-xs hover:opacity-100"
          style={{ color: 'var(--code-ink)', opacity: 0.7 }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        className="max-h-60 overflow-auto p-4 font-mono text-[0.8125rem] leading-5"
        style={{ color: 'var(--code-ink)', opacity: 0.86 }}
      >
        {block.output}
      </pre>
      {block.exit_code != null && (
        <div
          className="block-code-rule border-t px-4 py-1.5 text-right font-mono text-xs"
          style={{ color: success ? 'var(--code-add)' : 'var(--code-del)' }}
        >
          exit {block.exit_code}
        </div>
      )}
    </div>
  );
};
