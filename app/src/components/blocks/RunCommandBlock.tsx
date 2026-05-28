import { useState, useRef, useCallback } from 'react';
import type { RunCommandBlock as RunCommandBlockType } from '../../lib/blocks';

interface Props {
  block: RunCommandBlockType;
  onSelect: (blockId: string, type: string, value: string | null) => void;
  submitted: boolean;
}

const riskColor = {
  safe: 'bg-green-600',
  moderate: 'bg-yellow-600',
  dangerous: 'bg-red-600',
};

export const RunCommandBlockView = ({ block, onSelect, submitted }: Props) => {
  const [selected, setSelected] = useState<string | null>(null);
  const [holdProgress, setHoldProgress] = useState(0);
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const risk = block.risk || 'safe';
  const needsHold = risk === 'dangerous';

  // For dangerous: hold completes → auto-submitted by BlockRenderer
  const doRun = useCallback(() => {
    if (submitted || selected) return;
    setSelected('run');
    onSelect(block.id, 'run-command', 'run');
  }, [submitted, selected, block.id, onSelect]);

  const startHold = useCallback(() => {
    if (submitted || selected) return;
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
  }, [submitted, selected, doRun]);

  const endHold = useCallback(() => {
    if (holdTimer.current) clearInterval(holdTimer.current);
    if (!selected) setHoldProgress(0);
  }, [selected]);

  // For safe/moderate: tap to toggle selection
  const selectRun = () => {
    if (submitted) return;
    if (selected === 'run') {
      setSelected(null);
      onSelect(block.id, 'run-command', null);
    } else {
      setSelected('run');
      onSelect(block.id, 'run-command', 'run');
    }
  };

  const selectSkip = () => {
    if (submitted) return;
    if (selected === 'skip') {
      setSelected(null);
      onSelect(block.id, 'run-command', null);
    } else {
      setSelected('skip');
      onSelect(block.id, 'run-command', 'skip');
    }
  };

  const isLocked = submitted || (needsHold && selected !== null);

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-ink-soft bg-[#1b1b1b]">
      {block.description && (
        <div className="border-b border-ink-soft px-4 py-2 text-sm text-ink-fade">{block.description}</div>
      )}
      <div className="px-4 py-3 font-mono text-sm text-ink-fade">$ {block.command}</div>
      {!isLocked && (
        <div className="flex gap-2 border-t border-ink-soft px-4 py-3">
          {needsHold ? (
            <button
              type="button"
              onMouseDown={startHold}
              onMouseUp={endHold}
              onMouseLeave={endHold}
              onTouchStart={startHold}
              onTouchEnd={endHold}
              className={`relative overflow-hidden rounded-full px-5 py-2 text-sm font-semibold text-on-ink ${riskColor[risk]}`}
            >
              <div className="absolute inset-0 bg-red-800 transition-none" style={{ width: `${holdProgress}%` }} />
              <span className="relative">Hold to run</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={selectRun}
              className={`rounded-full px-5 py-2 text-sm font-semibold text-on-ink transition ${
                selected === 'run' ? `${riskColor[risk]} ring-2 ring-on-ink ring-offset-2 ring-offset-[#1b1b1b]` : riskColor[risk]
              }`}
            >
              Run
            </button>
          )}
          <button
            type="button"
            onClick={selectSkip}
            className={`rounded-full border px-5 py-2 text-sm font-medium transition ${
              selected === 'skip'
                ? 'border-surface bg-[#555] text-on-ink'
                : 'border-ink-soft text-ink-fade'
            }`}
          >
            Skip
          </button>
        </div>
      )}
      {isLocked && selected && (
        <div className={`border-t border-ink-soft px-4 py-2 text-sm font-medium ${selected === 'run' ? 'text-green-400' : 'text-ink-dim'}`}>
          {selected === 'run' ? 'Running...' : 'Skipped'}
        </div>
      )}
    </div>
  );
};
