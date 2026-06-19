// On-screen scroll-diagnostics overlay for #224 (agent/control switcher-scroll,
// iOS-PWA-only). Self-gating: renders nothing unless ?scrolldiag=1 was used.
// See lib/scroll-diag.ts. On each room entry it resets the log, stamps the
// room's kind/state, and samples scroll geometry for ~5s so we can read on an
// actual iPhone whether the foot-pin fires and is then overridden.
import { useEffect, useReducer } from 'react';
import {
  getScrollDiagLog,
  isScrollDiagEnabled,
  resetScrollDiag,
  scrollDiagLog,
  subscribeScrollDiag,
} from '../lib/scroll-diag';

type Props = {
  roomHash: string;
  roomKind: string;
  roomState: string;
  messageCount: number;
};

export const ScrollDiag = ({ roomHash, roomKind, roomState, messageCount }: Props) => {
  const enabled = isScrollDiagEnabled();
  const [, force] = useReducer((n: number) => n + 1, 0);

  // Re-render whenever the shared log changes.
  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeScrollDiag(force);
  }, [enabled]);

  // On every room entry: reset and sample scroll geometry for ~5s.
  useEffect(() => {
    if (!enabled || !roomHash) return undefined;
    resetScrollDiag();
    scrollDiagLog(`ENTER kind=${roomKind} state=${roomState} msgs=${messageCount}`);
    let n = 0;
    const id = window.setInterval(() => {
      const doc = document.documentElement;
      const dist = Math.round(doc.scrollHeight - (window.innerHeight + window.scrollY));
      const cards = document.querySelectorAll('[data-testid="message-card"]').length;
      scrollDiagLog(`y=${Math.round(window.scrollY)} h=${Math.round(doc.scrollHeight)} dist=${dist} cards=${cards}`);
      n += 1;
      if (n >= 34) window.clearInterval(id);
    }, 150);
    return () => window.clearInterval(id);
    // roomKind/roomState/messageCount are intentionally excluded: we want one
    // timeline per room ENTRY, with later kind/state changes logged separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, roomHash]);

  // Log the late kind/state transitions (the suspected iOS culprit: the daemon
  // re-stamps agent/control context a few ticks after entry).
  useEffect(() => {
    if (enabled && roomHash) scrollDiagLog(`state -> ${roomState}`);
  }, [enabled, roomHash, roomState]);
  useEffect(() => {
    if (enabled && roomHash) scrollDiagLog(`kind -> ${roomKind} msgs=${messageCount}`);
  }, [enabled, roomHash, roomKind, messageCount]);

  if (!enabled) return null;
  const lines = getScrollDiagLog();
  const text = lines.map((l) => `${l.t}ms ${l.msg}`).join('\n');
  return (
    <div className="fixed bottom-2 left-2 right-2 z-[100] max-h-[42vh] overflow-auto rounded-lg bg-black/85 p-2 font-mono text-[10px] leading-tight text-green-300">
      <div className="mb-1 flex items-center justify-between gap-2 text-white">
        <span className="truncate">scroll-diag · {roomKind}/{roomState} · {messageCount} msgs</span>
        <span className="flex shrink-0 gap-3">
          <button type="button" onClick={() => void navigator.clipboard?.writeText(text)}>
            copy
          </button>
          <button type="button" onClick={() => resetScrollDiag()}>
            clear
          </button>
        </span>
      </div>
      <pre className="m-0 whitespace-pre-wrap break-words">{text}</pre>
    </div>
  );
};
