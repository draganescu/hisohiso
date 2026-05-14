import { useState, useRef } from 'react';
import type { SortableBlock as SortableBlockType } from '../../lib/blocks';

interface Props {
  block: SortableBlockType;
  onRespond: (blockId: string, type: string, value: string[]) => void;
}

export const SortableBlockView = ({ block, onRespond }: Props) => {
  const [items, setItems] = useState(block.items.map((i) => ({ ...i })));
  const [submitted, setSubmitted] = useState(false);
  const dragIdx = useRef<number | null>(null);

  const submit = () => {
    if (submitted) return;
    setSubmitted(true);
    onRespond(block.id, 'sortable', items.map((i) => i.value));
  };

  const onDragStart = (idx: number) => {
    if (submitted) return;
    dragIdx.current = idx;
  };

  const onDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === idx) return;
    const next = [...items];
    const [moved] = next.splice(dragIdx.current, 1);
    next.splice(idx, 0, moved);
    dragIdx.current = idx;
    setItems(next);
  };

  const moveUp = (idx: number) => {
    if (submitted || idx === 0) return;
    const next = [...items];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    setItems(next);
  };

  const moveDown = (idx: number) => {
    if (submitted || idx === items.length - 1) return;
    const next = [...items];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    setItems(next);
  };

  return (
    <div className="mt-3">
      <p className="text-sm font-semibold">{block.prompt}</p>
      <div className="mt-2 space-y-1">
        {items.map((item, idx) => (
          <div
            key={item.value}
            draggable={!submitted}
            onDragStart={() => onDragStart(idx)}
            onDragOver={(e) => onDragOver(e, idx)}
            className={`flex items-center gap-2 rounded-xl border px-4 py-3 ${
              submitted ? 'border-[#e8e0d0] bg-[#f9f5ee]' : 'border-[#d5c8b2] bg-[#fdf9f2] cursor-grab active:cursor-grabbing'
            }`}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#e8dfd0] text-xs font-bold text-[#6a5e4e]">
              {idx + 1}
            </span>
            <span className="flex-1 text-sm text-[#171613]">{item.label}</span>
            {!submitted && (
              <span className="flex shrink-0 gap-1">
                <button type="button" onClick={() => moveUp(idx)} className="text-lg text-[#8d816c] active:text-[#171613]" aria-label="Move up">&#8593;</button>
                <button type="button" onClick={() => moveDown(idx)} className="text-lg text-[#8d816c] active:text-[#171613]" aria-label="Move down">&#8595;</button>
              </span>
            )}
          </div>
        ))}
      </div>
      {!submitted && (
        <button
          type="button"
          onClick={submit}
          className="mt-3 rounded-full bg-[#d9592f] px-5 py-2 text-sm font-semibold text-white"
        >
          {block.confirm_label || 'Confirm order'}
        </button>
      )}
    </div>
  );
};
