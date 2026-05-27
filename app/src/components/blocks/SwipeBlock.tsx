import { useState, useRef } from 'react';
import type { SwipeBlock as SwipeBlockType } from '../../lib/blocks';

interface Props {
  block: SwipeBlockType;
  onSelect: (blockId: string, type: string, value: string | null) => void;
  submitted: boolean;
}

export const SwipeBlockView = ({ block, onSelect, submitted }: Props) => {
  const [index, setIndex] = useState(0);
  const [selectedValue, setSelectedValue] = useState<string | null>(null);
  const [swipeX, setSwipeX] = useState(0);
  const startX = useRef(0);
  const dragging = useRef(false);

  const card = block.cards[index];
  if (!card) return null;

  const select = () => {
    if (submitted) return;
    if (selectedValue === card.value) {
      setSelectedValue(null);
      onSelect(block.id, 'swipe', null);
    } else {
      setSelectedValue(card.value);
      onSelect(block.id, 'swipe', card.value);
    }
  };

  const nextCard = () => {
    if (submitted) return;
    if (index < block.cards.length - 1) {
      setIndex(index + 1);
      setSwipeX(0);
    }
  };

  const onTouchStart = (e: React.TouchEvent) => {
    if (submitted) return;
    startX.current = e.touches[0].clientX;
    dragging.current = true;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (!dragging.current) return;
    setSwipeX(e.touches[0].clientX - startX.current);
  };

  const onTouchEnd = () => {
    dragging.current = false;
    if (swipeX > 80) select();
    else if (swipeX < -80) nextCard();
    setSwipeX(0);
  };

  const isCardSelected = selectedValue === card.value;
  const bgTint = isCardSelected
    ? 'border-green-400'
    : swipeX > 40
    ? 'border-green-400'
    : swipeX < -40
    ? 'border-red-400'
    : 'border-[#c4c4c4]';

  return (
    <div className="mt-3">
      <p className="text-sm font-semibold">{block.prompt}</p>
      <div className="mt-2 text-xs text-[#9a9a9a]">
        {index + 1} / {block.cards.length}
      </div>
      <div
        className={`mt-1 rounded-2xl border-2 bg-[#ffffff] p-4 transition-colors ${submitted ? 'border-green-400 opacity-70' : bgTint}`}
        style={{ transform: `translateX(${swipeX}px)`, transition: dragging.current ? 'none' : 'transform 0.2s' }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <p className="text-base font-semibold text-[#0a0a0a]">{card.title}</p>
        <p className="mt-2 text-sm leading-6 text-[#1a1a1a]">{card.body}</p>
        {card.pros && card.pros.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-green-700">Pros</p>
            <ul className="mt-1 space-y-1">
              {card.pros.map((p, i) => (
                <li key={i} className="text-sm text-[#1a1a1a]">+ {p}</li>
              ))}
            </ul>
          </div>
        )}
        {card.cons && card.cons.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-red-700">Cons</p>
            <ul className="mt-1 space-y-1">
              {card.cons.map((c, i) => (
                <li key={i} className="text-sm text-[#1a1a1a]">- {c}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {!submitted && (
        <div className="mt-3 flex justify-center gap-6">
          <button
            type="button"
            onClick={nextCard}
            disabled={index >= block.cards.length - 1}
            className="flex h-12 w-12 items-center justify-center rounded-full border border-red-300 bg-red-50 text-xl text-red-500 active:bg-red-100 disabled:opacity-30"
          >
            &#10005;
          </button>
          <button
            type="button"
            onClick={select}
            className={`flex h-12 w-12 items-center justify-center rounded-full border text-xl transition ${
              isCardSelected
                ? 'border-green-500 bg-green-500 text-white'
                : 'border-green-300 bg-green-50 text-green-600 active:bg-green-100'
            }`}
          >
            &#10003;
          </button>
        </div>
      )}
      {selectedValue && (
        <p className={`mt-2 text-center text-sm font-medium ${submitted ? 'text-green-700' : 'text-[#9a9a9a]'}`}>
          Selected: {block.cards.find((c) => c.value === selectedValue)?.title}
        </p>
      )}
    </div>
  );
};
