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
                  ? 'border-[#0a0a0a] bg-[#0a0a0a] text-white'
                  : submitted
                  ? 'border-[#c4c4c4] bg-[#efefec] text-[#9a9a9a] opacity-50'
                  : 'border-[#c4c4c4] bg-[#ffffff] text-[#0a0a0a] active:bg-[#efefec]'
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
