import { useState } from 'react';
import type { ButtonsBlock as ButtonsBlockType } from '../../lib/blocks';

interface Props {
  block: ButtonsBlockType;
  onSelect: (blockId: string, type: string, value: string | string[] | null) => void;
  submitted: boolean;
}

export const ButtonsBlockView = ({ block, onSelect, submitted }: Props) => {
  const [selected, setSelected] = useState<string[]>([]);

  const toggle = (value: string) => {
    if (submitted) return;
    if (block.multi) {
      const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
      setSelected(next);
      onSelect(block.id, 'buttons', next.length > 0 ? next : null);
    } else {
      if (selected[0] === value) {
        setSelected([]);
        onSelect(block.id, 'buttons', null);
      } else {
        setSelected([value]);
        onSelect(block.id, 'buttons', value);
      }
    }
  };

  return (
    <div className="mt-3">
      <p className="text-sm font-semibold">{block.prompt}</p>
      <div className={`mt-2 flex flex-wrap gap-2 ${block.style === 'stacked' ? 'flex-col' : ''}`}>
        {block.options.map((opt) => {
          const isSelected = selected.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              disabled={submitted && !isSelected}
              onClick={() => toggle(opt.value)}
              className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                isSelected
                  ? 'border-ink bg-ink text-on-ink'
                  : submitted
                  ? 'border-ink-fade bg-bg text-ink-dim opacity-50'
                  : 'border-ink-fade bg-surface text-ink active:bg-bg'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};
