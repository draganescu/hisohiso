import { useState, useRef, useMemo } from 'react';
import type { SwipeBlock as SwipeBlockType } from '../../lib/blocks';

type Verdict = 'good' | 'bad';

interface Props {
  block: SwipeBlockType;
  onSelect: (blockId: string, type: string, value: Record<string, Verdict> | null) => void;
  submitted: boolean;
}

export const SwipeBlockView = ({ block, onSelect, submitted }: Props) => {
  const [index, setIndex] = useState(0);
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [swipeX, setSwipeX] = useState(0);
  const startX = useRef(0);
  const dragging = useRef(false);

  const card = block.cards[index];
  const total = block.cards.length;
  const ratedCount = useMemo(() => Object.keys(verdicts).length, [verdicts]);
  const currentVerdict = card ? verdicts[card.value] : undefined;

  const pushUpdate = (next: Record<string, Verdict>) => {
    onSelect(block.id, 'swipe', Object.keys(next).length > 0 ? next : null);
  };

  const setVerdict = (value: Verdict) => {
    if (submitted || !card) return;
    const next = { ...verdicts };
    if (next[card.value] === value) delete next[card.value];
    else next[card.value] = value;
    setVerdicts(next);
    pushUpdate(next);
    if (next[card.value] && index < total - 1) {
      setTimeout(() => setIndex((i) => Math.min(i + 1, total - 1)), 120);
    }
  };

  const goPrev = () => { if (!submitted && index > 0) { setIndex(index - 1); setSwipeX(0); } };
  const goNext = () => { if (!submitted && index < total - 1) { setIndex(index + 1); setSwipeX(0); } };

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
    if (swipeX > 80) setVerdict('good');
    else if (swipeX < -80) setVerdict('bad');
    setSwipeX(0);
  };

  if (!card) return null;

  const bgTint = currentVerdict === 'good'
    ? 'border-green-400'
    : currentVerdict === 'bad'
    ? 'border-red-400'
    : swipeX > 40
    ? 'border-green-400'
    : swipeX < -40
    ? 'border-red-400'
    : 'border-ink-fade';

  return (
    <div className="mt-3">
      <p className="text-sm font-semibold">{block.prompt}</p>
      <div className="mt-2 flex items-center justify-between text-xs text-ink-dim">
        <span>{index + 1} / {total}</span>
        <span>{ratedCount} of {total} rated</span>
      </div>

      <div
        className={`mt-1 rounded-2xl border-2 bg-surface p-4 transition-colors ${submitted ? 'opacity-70' : bgTint}`}
        style={{ transform: `translateX(${swipeX}px)`, transition: dragging.current ? 'none' : 'transform 0.2s' }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <p className="text-base font-semibold text-ink">{card.title}</p>
        <p className="mt-2 text-sm leading-6 text-ink">{card.body}</p>
        {card.pros && card.pros.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-green-700">Pros</p>
            <ul className="mt-1 space-y-1">
              {card.pros.map((p, i) => (
                <li key={i} className="text-sm text-ink">+ {p}</li>
              ))}
            </ul>
          </div>
        )}
        {card.cons && card.cons.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-red-700">Cons</p>
            <ul className="mt-1 space-y-1">
              {card.cons.map((c, i) => (
                <li key={i} className="text-sm text-ink">- {c}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {!submitted && (
        <>
          <div className="mt-3 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={goPrev}
              disabled={index === 0}
              className="rounded-full border border-rule bg-surface px-3 py-2 text-xs font-medium text-ink disabled:opacity-30"
            >
              ← Back
            </button>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setVerdict('bad')}
                className={`flex h-12 w-12 items-center justify-center rounded-full border text-xl transition ${
                  currentVerdict === 'bad'
                    ? 'border-red-500 bg-red-500 text-on-ink'
                    : 'border-red-300 bg-red-50 text-red-500 active:bg-red-100'
                }`}
              >
                &#10005;
              </button>
              <button
                type="button"
                onClick={() => setVerdict('good')}
                className={`flex h-12 w-12 items-center justify-center rounded-full border text-xl transition ${
                  currentVerdict === 'good'
                    ? 'border-green-500 bg-green-500 text-on-ink'
                    : 'border-green-300 bg-green-50 text-green-600 active:bg-green-100'
                }`}
              >
                &#10003;
              </button>
            </div>
            <button
              type="button"
              onClick={goNext}
              disabled={index === total - 1}
              className="rounded-full border border-rule bg-surface px-3 py-2 text-xs font-medium text-ink disabled:opacity-30"
            >
              Next →
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {block.cards.map((c, i) => {
              const v = verdicts[c.value];
              const isCurrent = i === index;
              const base = 'h-2 flex-1 min-w-[12px] rounded-full transition';
              const color = v === 'good'
                ? 'bg-green-500'
                : v === 'bad'
                ? 'bg-red-500'
                : 'bg-ink-fade';
              return (
                <button
                  key={c.value}
                  type="button"
                  aria-label={`Go to card ${i + 1}`}
                  onClick={() => { setIndex(i); setSwipeX(0); }}
                  className={`${base} ${color} ${isCurrent ? 'ring-2 ring-offset-1 ring-ink' : ''}`}
                />
              );
            })}
          </div>
        </>
      )}

      {submitted && (
        <div className="mt-3 text-xs text-ink-dim">
          Submitted {ratedCount} rating{ratedCount === 1 ? '' : 's'}.
        </div>
      )}
    </div>
  );
};
