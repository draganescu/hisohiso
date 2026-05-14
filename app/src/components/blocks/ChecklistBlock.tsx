import { useState } from 'react';
import type { ChecklistBlock as ChecklistBlockType } from '../../lib/blocks';

interface Props {
  block: ChecklistBlockType;
  onRespond: (blockId: string, type: string, value: string[]) => void;
}

export const ChecklistBlockView = ({ block, onRespond }: Props) => {
  const [checked, setChecked] = useState<string[]>(
    block.items.filter((i) => i.checked).map((i) => i.value)
  );
  const [submitted, setSubmitted] = useState(false);

  const toggle = (value: string) => {
    if (submitted) return;
    setChecked((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  };

  const submit = () => {
    if (submitted) return;
    setSubmitted(true);
    onRespond(block.id, 'checklist', checked);
  };

  return (
    <div className="mt-3">
      <p className="text-sm font-semibold">{block.prompt}</p>
      <div className="mt-2 space-y-2">
        {block.items.map((item) => (
          <label
            key={item.value}
            className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition ${
              submitted
                ? checked.includes(item.value)
                  ? 'border-[#d9592f] bg-[#fdf1ec]'
                  : 'border-[#e8e0d0] bg-[#f9f5ee] opacity-50'
                : checked.includes(item.value)
                ? 'border-[#d9592f] bg-[#fdf1ec]'
                : 'border-[#d5c8b2] bg-[#fdf9f2]'
            }`}
          >
            <input
              type="checkbox"
              checked={checked.includes(item.value)}
              disabled={submitted}
              onChange={() => toggle(item.value)}
              className="h-4 w-4 accent-[#d9592f]"
            />
            <span className="text-sm text-[#171613]">{item.label}</span>
          </label>
        ))}
      </div>
      {!submitted && (
        <button
          type="button"
          onClick={submit}
          className="mt-3 rounded-full bg-[#d9592f] px-5 py-2 text-sm font-semibold text-white"
        >
          {block.confirm_label || 'Confirm'}
        </button>
      )}
    </div>
  );
};
