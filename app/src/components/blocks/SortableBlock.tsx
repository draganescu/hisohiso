import { useState, useRef, useCallback } from 'react';
import type { SortableBlock as SortableBlockType } from '../../lib/blocks';

interface Props {
  block: SortableBlockType;
  onRespond: (blockId: string, type: string, value: string[]) => void;
}

export const SortableBlockView = ({ block, onRespond }: Props) => {
  const [items, setItems] = useState(block.items.map((i) => ({ ...i })));
  const [submitted, setSubmitted] = useState(false);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const touchStartY = useRef(0);
  const touchCurrentIdx = useRef<number | null>(null);

  const submit = () => {
    if (submitted) return;
    setSubmitted(true);
    onRespond(block.id, 'sortable', items.map((i) => i.value));
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

  const getIdxFromY = useCallback((clientY: number): number | null => {
    for (let i = 0; i < rowRefs.current.length; i++) {
      const el = rowRefs.current[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) return i;
    }
    return null;
  }, []);

  const onTouchStart = (idx: number, e: React.TouchEvent) => {
    if (submitted) return;
    e.preventDefault();
    touchStartY.current = e.touches[0].clientY;
    touchCurrentIdx.current = idx;
    setDraggingIdx(idx);
  };

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchCurrentIdx.current === null) return;
    e.preventDefault();
    const overIdx = getIdxFromY(e.touches[0].clientY);
    if (overIdx !== null && overIdx !== touchCurrentIdx.current) {
      setItems((prev) => {
        const next = [...prev];
        const [moved] = next.splice(touchCurrentIdx.current!, 1);
        next.splice(overIdx, 0, moved);
        touchCurrentIdx.current = overIdx;
        setDraggingIdx(overIdx);
        return next;
      });
    }
  }, [getIdxFromY]);

  const onTouchEnd = useCallback(() => {
    touchCurrentIdx.current = null;
    setDraggingIdx(null);
  }, []);

  return (
    <div className="mt-3">
      <p className="text-sm font-semibold">{block.prompt}</p>
      <div className="mt-2 space-y-1" onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
        {items.map((item, idx) => (
          <div
            key={item.value}
            ref={(el) => { rowRefs.current[idx] = el; }}
            className={`flex items-center gap-2 rounded-xl border px-4 py-3 transition-colors ${
              submitted
                ? 'border-[#e8e0d0] bg-[#f9f5ee]'
                : draggingIdx === idx
                ? 'border-[#d9592f] bg-[#fdf1ec] shadow-lg'
                : 'border-[#d5c8b2] bg-[#fdf9f2]'
            }`}
          >
            {!submitted && (
              <span
                onTouchStart={(e) => onTouchStart(idx, e)}
                className="flex h-8 w-8 shrink-0 touch-none select-none items-center justify-center rounded-lg text-lg text-[#8d816c] active:bg-[#e8dfd0]"
              >
                &#9776;
              </span>
            )}
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#e8dfd0] text-xs font-bold text-[#6a5e4e]">
              {idx + 1}
            </span>
            <span className="flex-1 text-sm text-[#171613]">{item.label}</span>
            {!submitted && (
              <span className="flex shrink-0 gap-1">
                <button type="button" onClick={() => moveUp(idx)} className="flex h-8 w-8 items-center justify-center rounded-lg text-lg text-[#8d816c] active:bg-[#e8dfd0] active:text-[#171613]" aria-label="Move up">&#8593;</button>
                <button type="button" onClick={() => moveDown(idx)} className="flex h-8 w-8 items-center justify-center rounded-lg text-lg text-[#8d816c] active:bg-[#e8dfd0] active:text-[#171613]" aria-label="Move down">&#8595;</button>
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
