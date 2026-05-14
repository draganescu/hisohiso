import { useState } from 'react';
import type { CommitBlock as CommitBlockType } from '../../lib/blocks';

interface Props {
  block: CommitBlockType;
  onRespond: (blockId: string, type: string, value: string) => void;
}

export const CommitBlockView = ({ block, onRespond }: Props) => {
  const [submitted, setSubmitted] = useState<string | null>(null);
  const lines = block.message.split('\n');
  const subject = lines[0];
  const body = lines.slice(1).join('\n').trim();

  const respond = (action: 'commit' | 'edit' | 'cancel') => {
    if (submitted) return;
    setSubmitted(action);
    onRespond(block.id, 'commit', action);
  };

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-[#d5c8b2] bg-[#fdf9f2]">
      <div className="border-b border-[#e8e0d0] px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#8d816c]">Commit</p>
        <p className="mt-1 text-base font-bold text-[#171613]">{subject}</p>
        {body && <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#3f3529]">{body}</p>}
      </div>
      {(block.files || block.stats) && (
        <div className="border-b border-[#e8e0d0] px-4 py-2.5">
          {block.files && (
            <div className="flex flex-wrap gap-1.5">
              {block.files.map((f) => (
                <span key={f} className="rounded-full bg-[#e8dfd0] px-2.5 py-0.5 font-mono text-xs text-[#3f3529]">
                  {f}
                </span>
              ))}
            </div>
          )}
          {block.stats && (
            <div className="mt-1.5 flex gap-2 text-xs font-semibold">
              <span className="text-green-600">+{block.stats.additions}</span>
              <span className="text-red-500">-{block.stats.deletions}</span>
            </div>
          )}
        </div>
      )}
      {!submitted && (
        <div className="flex gap-2 px-4 py-3">
          <button type="button" onClick={() => respond('commit')} className="rounded-full bg-green-600 px-5 py-2 text-sm font-semibold text-white">
            Commit
          </button>
          <button type="button" onClick={() => respond('edit')} className="rounded-full border border-[#d5c8b2] bg-[#fdf9f2] px-5 py-2 text-sm font-medium text-[#171613]">
            Edit
          </button>
          <button type="button" onClick={() => respond('cancel')} className="rounded-full border border-[#d5c8b2] bg-[#fdf9f2] px-5 py-2 text-sm font-medium text-[#8d816c]">
            Cancel
          </button>
        </div>
      )}
      {submitted && (
        <div className="px-4 py-2 text-sm font-medium capitalize text-[#8d816c]">{submitted === 'commit' ? 'Committed' : submitted === 'edit' ? 'Editing...' : 'Cancelled'}</div>
      )}
    </div>
  );
};
