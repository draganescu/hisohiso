import { useState, useRef, useCallback } from 'react';
import type { RunCommandBlock as RunCommandBlockType } from '../../lib/blocks';

interface Props {
  block: RunCommandBlockType;
  onRespond: (blockId: string, type: string, value: string) => void;
}

const riskColor = {
  safe: 'bg-green-600',
  moderate: 'bg-yellow-600',
  dangerous: 'bg-red-600',
};

export const RunCommandBlockView = ({ block, onRespond }: Props) => {
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [holdProgress, setHoldProgress] = useState(0);
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const risk = block.risk || 'safe';
  const needsHold = risk === 'dangerous';

  const doRun = useCallback(() => {
    if (submitted) return;
    setSubmitted('run');
    onRespond(block.id, 'run-command', 'run');
  }, [submitted, block.id, onRespond]);

  const startHold = useCallback(() => {
    if (submitted) return;
    setHoldProgress(0);
    let p = 0;
    holdTimer.current = setInterval(() => {
      p += 2;
      setHoldProgress(p);
      if (p >= 100) {
        if (holdTimer.current) clearInterval(holdTimer.current);
        doRun();
      }
    }, 20);
  }, [submitted, doRun]);

  const endHold = useCallback(() => {
    if (holdTimer.current) clearInterval(holdTimer.current);
    if (!submitted) setHoldProgress(0);
  }, [submitted]);

  const skip = () => {
    if (submitted) return;
    setSubmitted('skip');
    onRespond(block.id, 'run-command', 'skip');
  };

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-[#333] bg-[#1b1b1b]">
      {block.description && (
        <div className="border-b border-[#333] px-4 py-2 text-sm text-[#aaa]">{block.description}</div>
      )}
      <div className="px-4 py-3 font-mono text-sm text-[#ccc]">$ {block.command}</div>
      {!submitted && (
        <div className="flex gap-2 border-t border-[#333] px-4 py-3">
          {needsHold ? (
            <button
              type="button"
              onMouseDown={startHold}
              onMouseUp={endHold}
              onMouseLeave={endHold}
              onTouchStart={startHold}
              onTouchEnd={endHold}
              className={`relative overflow-hidden rounded-full px-5 py-2 text-sm font-semibold text-white ${riskColor[risk]}`}
            >
              <div className="absolute inset-0 bg-red-800 transition-none" style={{ width: `${holdProgress}%` }} />
              <span className="relative">Hold to run</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={doRun}
              className={`rounded-full px-5 py-2 text-sm font-semibold text-white ${riskColor[risk]}`}
            >
              Run
            </button>
          )}
          <button type="button" onClick={skip} className="rounded-full border border-[#555] px-5 py-2 text-sm font-medium text-[#aaa]">
            Skip
          </button>
        </div>
      )}
      {submitted && (
        <div className={`border-t border-[#333] px-4 py-2 text-sm font-medium ${submitted === 'run' ? 'text-green-400' : 'text-[#888]'}`}>
          {submitted === 'run' ? 'Running...' : 'Skipped'}
        </div>
      )}
    </div>
  );
};
