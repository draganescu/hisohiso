import { useRef, useState } from 'react';
import type { CarouselBlock as CarouselBlockType } from '../../lib/blocks';

interface Props {
  block: CarouselBlockType;
}

export const CarouselBlockView = ({ block }: Props) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const cardWidth = el.firstElementChild?.clientWidth ?? 1;
    const idx = Math.round(el.scrollLeft / cardWidth);
    setActive(Math.min(idx, block.cards.length - 1));
  };

  return (
    <div className="mt-3">
      {block.title && <p className="text-sm font-semibold">{block.title}</p>}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="mt-2 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2"
        style={{ scrollbarWidth: 'none', touchAction: 'pan-x' }}
      >
        {block.cards.map((card, i) => (
          <div
            key={i}
            className="w-[75vw] max-w-[280px] shrink-0 snap-start last:snap-end rounded-2xl border border-[#c4c4c4] bg-[#ffffff] p-4"
          >
            <p className="text-sm font-semibold text-[#0a0a0a]">{card.title}</p>
            {card.subtitle && <p className="mt-1 font-mono text-xs text-[#9a9a9a]">{card.subtitle}</p>}
            {card.preview && (
              <p className="mt-2 font-mono text-[13px] leading-5 text-[#1a1a1a]">{card.preview}</p>
            )}
            {card.meta && <p className="mt-2 text-xs text-[#9a9a9a]">{card.meta}</p>}
          </div>
        ))}
      </div>
      {block.cards.length > 1 && (
        <div className="mt-1 flex justify-center gap-1.5">
          {block.cards.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 w-1.5 rounded-full ${i === active ? 'bg-[#0a0a0a]' : 'bg-[#c4c4c4]'}`}
            />
          ))}
        </div>
      )}
    </div>
  );
};
