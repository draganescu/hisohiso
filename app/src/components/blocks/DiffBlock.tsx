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

  // Optional: a follow-up message (or the diff itself) may stamp a commit hash.
  // Absent on a pending diff — when absent we render no footer. The field
  // arrives over the existing E2E channel; nothing here assumes server
  // behaviour. We only ever state what the sha itself proves — that a commit
  // exists — and never narrate an approve/apply sequence the client did not
  // observe (the presence of a sha is not evidence of approval).
  // TODO(server): no relay field carries a commit sha back to a prior diff today;
  // this renders only if a `sha`/`committed_sha` is voluntarily included.
  const committedSha = block.committed_sha ?? block.sha;

  return (
    <div className="block-card mt-3 rounded-2xl">
      <div className="block-code block-code-rule flex items-center justify-between border-b px-4 py-2.5">
        <span className="font-mono text-sm" style={{ color: 'var(--code-ink)' }}>{block.file}</span>
        {block.stats && (
          <span className="flex gap-2 text-xs font-semibold">
            <span style={{ color: 'var(--code-add)' }}>+{block.stats.additions}</span>
            <span style={{ color: 'var(--code-del)' }}>-{block.stats.deletions}</span>
          </span>
        )}
      </div>
      {block.hunks.map((hunk, hi) => (
        <div key={hi} className="block-code">
          <button
            type="button"
            onClick={() => toggleHunk(hi)}
            className="block-code-rule w-full border-b px-4 py-1.5 text-left font-mono text-xs"
            style={{ color: 'var(--code-ink)', opacity: 0.7 }}
          >
            {expandedHunks.has(hi) ? '▾' : '▸'} {hunk.header}
          </button>
          {expandedHunks.has(hi) && (
            <div className="overflow-x-auto">
              {hunk.lines.map((line, li) => (
                <div
                  key={li}
                  className="whitespace-pre px-4 py-0.5 font-mono text-[0.8125rem] leading-5"
                  style={
                    line.op === '+'
                      ? { background: 'var(--code-add-bg)', color: 'var(--code-add)' }
                      : line.op === '-'
                      ? { background: 'var(--code-del-bg)', color: 'var(--code-del)' }
                      : { color: 'var(--code-ink)', opacity: 0.62 }
                  }
                >
                  <span className="mr-2 inline-block w-4 text-center" style={{ color: 'var(--code-ink)', opacity: 0.55 }}>{line.op}</span>
                  {line.text}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {committedSha && (
        <div className="block-commit-confirm px-4 py-2 font-mono text-xs">
          committed{' '}
          <span className="font-semibold">{committedSha.slice(0, 10)}</span>
        </div>
      )}
    </div>
  );
};
