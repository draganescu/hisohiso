import { useState } from 'react';
import type { ButtonsBlock as ButtonsBlockType } from '../../lib/blocks';

interface Props {
  block: ButtonsBlockType;
  onRespond: (blockId: string, type: string, value: string | string[]) => void;
}

export const ButtonsBlockView = ({ block, onRespond }: Props) => {
  const [selected, setSelected] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);

  const toggle = (value: string) => {
    if (submitted) return;
    if (block.multi) {
      setSelected((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
    } else {
      setSelected([value]);
      setSubmitted(true);
      onRespond(block.id, 'buttons', value);
    }
  };

  const confirm = () => {
    if (submitted || selected.length === 0) return;
    setSubmitted(true);
    onRespond(block.id, 'buttons', selected);
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
                  ? 'border-[#d9592f] bg-[#d9592f] text-white'
                  : submitted
                  ? 'border-[#d5c8b2] bg-[#f4ede1] text-[#a89e90] opacity-50'
                  : 'border-[#d5c8b2] bg-[#fdf9f2] text-[#171613] active:bg-[#f4ede1]'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {block.multi && !submitted && selected.length > 0 && (
        <button
          type="button"
          onClick={confirm}
          className="mt-3 rounded-full bg-[#d9592f] px-5 py-2 text-sm font-semibold text-white"
        >
          Confirm
        </button>
      )}
    </div>
  );
};
