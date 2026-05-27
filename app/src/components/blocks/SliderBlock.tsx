import { useState } from 'react';
import type { SliderBlock as SliderBlockType } from '../../lib/blocks';

interface Props {
  block: SliderBlockType;
  onSelect: (blockId: string, type: string, value: number) => void;
  submitted: boolean;
}

export const SliderBlockView = ({ block, onSelect, submitted }: Props) => {
  const [value, setValue] = useState(block.default ?? Math.round((block.min.value + block.max.value) / 2));

  const step = block.steps
    ? (block.max.value - block.min.value) / block.steps
    : 1;

  const onChange = (newValue: number) => {
    if (submitted) return;
    setValue(newValue);
    onSelect(block.id, 'slider', newValue);
  };

  return (
    <div className="mt-3">
      <p className="text-sm font-semibold">{block.prompt}</p>
      <div className="mt-3 px-1">
        <input
          type="range"
          min={block.min.value}
          max={block.max.value}
          step={step}
          value={value}
          disabled={submitted}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full accent-[#0a0a0a]"
        />
        <div className="mt-1 flex justify-between text-xs text-[#9a9a9a]">
          <span>{block.min.label}</span>
          <span className="font-semibold text-[#0a0a0a]">{value}</span>
          <span>{block.max.label}</span>
        </div>
      </div>
    </div>
  );
};
