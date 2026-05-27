import { useState } from 'react';
import type { ChecklistBlock as ChecklistBlockType } from '../../lib/blocks';

interface Props {
  block: ChecklistBlockType;
  onSelect: (blockId: string, type: string, value: string[] | null) => void;
  submitted: boolean;
}

export const ChecklistBlockView = ({ block, onSelect, submitted }: Props) => {
  const [checked, setChecked] = useState<string[]>(
    block.items.filter((i) => i.checked).map((i) => i.value)
  );

  const toggle = (value: string) => {
    if (submitted) return;
    const next = checked.includes(value) ? checked.filter((v) => v !== value) : [...checked, value];
    setChecked(next);
    onSelect(block.id, 'checklist', next.length > 0 ? next : null);
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
                  ? 'border-[#0a0a0a] bg-[#efefec]'
                  : 'border-[#e8e0d0] bg-[#f9f5ee] opacity-50'
                : checked.includes(item.value)
                ? 'border-[#0a0a0a] bg-[#efefec]'
                : 'border-[#c4c4c4] bg-[#ffffff]'
            }`}
          >
            <input
              type="checkbox"
              checked={checked.includes(item.value)}
              disabled={submitted}
              onChange={() => toggle(item.value)}
              className="h-4 w-4 accent-[#0a0a0a]"
            />
            <span className="text-sm text-[#0a0a0a]">{item.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
};
