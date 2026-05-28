import type { FilePeekBlock as FilePeekBlockType } from '../../lib/blocks';

interface Props {
  block: FilePeekBlockType;
}

export const FilePeekBlockView = ({ block }: Props) => {
  const lines = block.content.split('\n');
  const startLine = block.start_line ?? 1;

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-ink-soft bg-[#1b1b1b]">
      <div className="flex items-center justify-between border-b border-ink-soft px-4 py-2">
        <span className="font-mono text-xs text-ink-soft">{block.file}</span>
        {block.total_lines != null && (
          <span className="text-xs text-ink-dim">
            {startLine}-{startLine + lines.length - 1} of {block.total_lines}
          </span>
        )}
      </div>
      <div className="max-h-60 overflow-auto">
        {lines.map((line, i) => (
          <div key={i} className="flex font-mono text-[13px] leading-5">
            <span className="w-12 shrink-0 select-none pr-3 text-right text-ink-soft">{startLine + i}</span>
            <span className="whitespace-pre text-ink-fade">{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
