import { useState, useRef, useCallback } from 'react';
import type { ConfirmDangerBlock as ConfirmDangerBlockType } from '../../lib/blocks';

interface Props {
  block: ConfirmDangerBlockType;
  onSelect: (blockId: string, type: string, value: boolean) => void;
  submitted: boolean;
}

export const ConfirmDangerBlockView = ({ block, onSelect, submitted }: Props) => {
  const [selected, setSelected] = useState<boolean | null>(null);
  const [holdProgress, setHoldProgress] = useState(0);
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Once selected locally, lock immediately (auto-submit blocks don't wait for Send)
  const isLocked = submitted || selected !== null;

  const startHold = useCallback(() => {
    if (isLocked) return;
    setHoldProgress(0);
    let p = 0;
    holdTimer.current = setInterval(() => {
      p += 2;
      setHoldProgress(p);
      if (p >= 100) {
        if (holdTimer.current) clearInterval(holdTimer.current);
        setSelected(true);
        onSelect(block.id, 'confirm-danger', true);
      }
    }, 20);
  }, [isLocked, block.id, onSelect]);

  const endHold = useCallback(() => {
    if (holdTimer.current) clearInterval(holdTimer.current);
    if (selected === null) setHoldProgress(0);
  }, [selected]);

  const cancel = () => {
    if (isLocked) return;
    setSelected(false);
    onSelect(block.id, 'confirm-danger', false);
  };

  return (
    <div className="block-card mt-3 rounded-2xl border-2 border-danger bg-danger-soft">
      <div className="px-4 py-3">
        <p className="flex items-center gap-2 font-semibold text-danger">
          <span className="text-lg">&#9888;</span> {block.title}
        </p>
        <p className="mt-2 text-sm leading-6 text-ink">{block.description}</p>
        {block.command && (
          <pre className="block-code mt-2 rounded-xl px-4 py-2 font-mono text-[0.8125rem]" style={{ color: 'var(--code-ink)', opacity: 0.86 }}>
            $ {block.command}
          </pre>
        )}
      </div>
      {!isLocked && (
        <div className="flex gap-2 border-t border-danger/30 px-4 py-3">
          <button
            type="button"
            onClick={cancel}
            className="btn-ghost"
          >
            {block.cancel_label || 'Cancel'}
          </button>
          <button
            type="button"
            onMouseDown={startHold}
            onMouseUp={endHold}
            onMouseLeave={endHold}
            onTouchStart={startHold}
            onTouchEnd={endHold}
            onContextMenu={(e) => e.preventDefault()}
            style={{ WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none' }}
            className="relative select-none overflow-hidden rounded-full bg-danger px-5 py-2 text-sm font-semibold text-on-ink touch-none"
          >
            <div
              className="pointer-events-none absolute inset-0 transition-none"
              style={{ width: `${holdProgress}%`, background: 'color-mix(in srgb, var(--danger) 55%, #000)' }}
            />
            <span className="pointer-events-none relative select-none">{block.confirm_label || 'Confirm'}</span>
          </button>
        </div>
      )}
      {isLocked && selected === true && (
        <div className="border-t border-danger/30 px-4 py-2 text-sm font-medium text-danger">Confirmed</div>
      )}
      {isLocked && selected === false && (
        <div className="border-t border-danger/30 px-4 py-2 text-sm font-medium text-ink-dim">Cancelled</div>
      )}
    </div>
  );
};
