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
    <div className="mt-3 overflow-hidden rounded-2xl border-2 border-red-400 bg-[#fef5f3]">
      <div className="px-4 py-3">
        <p className="flex items-center gap-2 font-semibold text-red-800">
          <span className="text-lg">&#9888;</span> {block.title}
        </p>
        <p className="mt-2 text-sm leading-6 text-[#1a1a1a]">{block.description}</p>
        {block.command && (
          <pre className="mt-2 rounded-xl bg-[#1b1b1b] px-4 py-2 font-mono text-[13px] text-[#ccc]">
            $ {block.command}
          </pre>
        )}
      </div>
      {!isLocked && (
        <div className="flex gap-2 border-t border-red-200 px-4 py-3">
          <button
            type="button"
            onClick={cancel}
            className="rounded-full border border-[#c4c4c4] bg-[#ffffff] px-5 py-2 text-sm font-medium text-[#0a0a0a]"
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
            className="relative overflow-hidden rounded-full bg-red-600 px-5 py-2 text-sm font-semibold text-white"
          >
            <div
              className="absolute inset-0 bg-red-800 transition-none"
              style={{ width: `${holdProgress}%` }}
            />
            <span className="relative">{block.confirm_label || 'Confirm'}</span>
          </button>
        </div>
      )}
      {isLocked && selected === true && (
        <div className="border-t border-red-200 px-4 py-2 text-sm font-medium text-red-700">Confirmed</div>
      )}
      {isLocked && selected === false && (
        <div className="border-t border-red-200 px-4 py-2 text-sm font-medium text-[#9a9a9a]">Cancelled</div>
      )}
    </div>
  );
};
