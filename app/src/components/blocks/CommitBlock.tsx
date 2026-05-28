import { useState } from 'react';
import type { CommitBlock as CommitBlockType } from '../../lib/blocks';

interface Props {
  block: CommitBlockType;
  onSelect: (blockId: string, type: string, value: string | null) => void;
  submitted: boolean;
}

export const CommitBlockView = ({ block, onSelect, submitted }: Props) => {
  const [selected, setSelected] = useState<string | null>(null);
  const lines = block.message.split('\n');
  const subject = lines[0];
  const body = lines.slice(1).join('\n').trim();

  const select = (action: string) => {
    if (submitted) return;
    if (selected === action) {
      setSelected(null);
      onSelect(block.id, 'commit', null);
    } else {
      setSelected(action);
      onSelect(block.id, 'commit', action);
    }
  };

  const actionStyle = (action: string, base: string, selectedStyle: string) =>
    selected === action
      ? selectedStyle
      : submitted
      ? 'border-ink-fade bg-bg text-ink-dim opacity-50'
      : base;

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-ink-fade bg-surface">
      <div className="border-b border-rule px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-dim">Commit</p>
        <p className="mt-1 text-base font-bold text-ink">{subject}</p>
        {body && <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink">{body}</p>}
      </div>
      {(block.files || block.stats) && (
        <div className="border-b border-rule px-4 py-2.5">
          {block.files && (
            <div className="flex flex-wrap gap-1.5">
              {block.files.map((f) => (
                <span key={f} className="rounded-full bg-bg px-2.5 py-0.5 font-mono text-xs text-ink">
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
      <div className="flex gap-2 px-4 py-3">
        <button
          type="button"
          disabled={submitted && selected !== 'commit'}
          onClick={() => select('commit')}
          className={`rounded-full px-5 py-2 text-sm font-semibold transition ${actionStyle(
            'commit',
            'bg-green-600 text-on-ink active:bg-green-700',
            'bg-green-600 text-on-ink ring-2 ring-green-400 ring-offset-2'
          )}`}
        >
          Commit
        </button>
        <button
          type="button"
          disabled={submitted && selected !== 'edit'}
          onClick={() => select('edit')}
          className={`rounded-full border px-5 py-2 text-sm font-medium transition ${actionStyle(
            'edit',
            'border-ink-fade bg-surface text-ink active:bg-bg',
            'border-ink bg-filled text-on-ink'
          )}`}
        >
          Edit
        </button>
        <button
          type="button"
          disabled={submitted && selected !== 'cancel'}
          onClick={() => select('cancel')}
          className={`rounded-full border px-5 py-2 text-sm font-medium transition ${actionStyle(
            'cancel',
            'border-ink-fade bg-surface text-ink-dim active:bg-bg',
            'border-ink bg-filled text-on-ink'
          )}`}
        >
          Cancel
        </button>
      </div>
      {submitted && selected && (
        <div className="border-t border-rule px-4 py-2 text-sm font-medium capitalize text-ink-dim">
          {selected === 'commit' ? 'Committed' : selected === 'edit' ? 'Editing...' : 'Cancelled'}
        </div>
      )}
    </div>
  );
};
