import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

// Sliding-window over a list rendered newest-first (index 0 = newest, end = oldest).
// Storage is untouched — the hook only chooses which slice of the in-memory array is
// passed to the DOM. Two sentinels (mounted by the caller via the returned callback
// refs) drive expansion in either direction; the scroll position is preserved when
// items are inserted at the visual top of the list so the viewport doesn't jump.

type Params = {
  pageSize?: number;       // items added/removed per page event
  cap?: number;            // max rendered items at once
  initialTail?: number;    // window size on first population
  rootMargin?: string;     // IntersectionObserver root margin
};

const DEFAULTS: Required<Params> = {
  pageSize: 50,
  cap: 150,
  initialTail: 100,
  rootMargin: '300px 0px',
};

export const useMessageWindow = <T extends { id: string }>(
  items: T[],
  scrollContainerRef: RefObject<HTMLElement | null>,
  params?: Params
) => {
  const cfg = { ...DEFAULTS, ...(params ?? {}) };

  const [windowStart, setWindowStart] = useState(0);
  const [windowEnd, setWindowEnd] = useState(0);

  // Tracks the id at the visual top of items between renders so we can detect
  // prepends (live new messages always sort to index 0 in the desc array) and
  // shift indices to keep the rendered slice anchored to the same messages.
  const prevTopIdRef = useRef<string | null>(null);

  // Capture-restore for scroll position when the window grows at the DOM top.
  // Filled before mutating windowStart; consumed in useLayoutEffect after commit.
  const scrollAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);

  useEffect(() => {
    const newTopId = items[0]?.id ?? null;
    const prevTopId = prevTopIdRef.current;

    if (prevTopId === null) {
      // First time we see items, or coming back from an empty list — pin window to newest.
      setWindowStart(0);
      setWindowEnd(Math.min(cfg.initialTail, items.length));
    } else if (newTopId !== prevTopId) {
      const oldTopIndex = newTopId === null ? -1 : items.findIndex((i) => i.id === prevTopId);
      if (oldTopIndex > 0) {
        // Prepend of `oldTopIndex` items at the visual top of the array.
        const growth = oldTopIndex;
        setWindowStart((s) => (s > 0 ? s + growth : 0));
        setWindowEnd((e) => Math.min(e + growth, items.length));
      } else {
        // Reset (room switch, hard reload, full reset). Re-pin to newest.
        setWindowStart(0);
        setWindowEnd(Math.min(cfg.initialTail, items.length));
      }
    } else {
      // Top unchanged — clamp end in case items shrank (e.g. a delete).
      setWindowEnd((e) => Math.min(e, items.length));
    }

    prevTopIdRef.current = newTopId;
  }, [items, cfg.initialTail]);

  const expandToOlder = useCallback(() => {
    if (windowEnd >= items.length) return;
    const newEnd = Math.min(items.length, windowEnd + cfg.pageSize);
    const newStart = newEnd - windowStart > cfg.cap ? windowStart + cfg.pageSize : windowStart;
    setWindowEnd(newEnd);
    if (newStart !== windowStart) setWindowStart(newStart);
  }, [items.length, windowStart, windowEnd, cfg.pageSize, cfg.cap]);

  const expandToNewer = useCallback(() => {
    if (windowStart === 0) return;
    const el = scrollContainerRef.current;
    if (el) {
      scrollAnchorRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
    }
    const newStart = Math.max(0, windowStart - cfg.pageSize);
    const newEnd = windowEnd - newStart > cfg.cap ? windowEnd - cfg.pageSize : windowEnd;
    setWindowStart(newStart);
    if (newEnd !== windowEnd) setWindowEnd(newEnd);
  }, [scrollContainerRef, windowStart, windowEnd, cfg.pageSize, cfg.cap]);

  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    const anchor = scrollAnchorRef.current;
    if (!el || !anchor) return;
    const delta = el.scrollHeight - anchor.scrollHeight;
    if (delta !== 0) el.scrollTop = anchor.scrollTop + delta;
    scrollAnchorRef.current = null;
  });

  // Callback refs so the IntersectionObserver effect re-runs when the sentinels
  // mount or unmount (refs don't fire effects on assignment).
  const [topSentinel, setTopSentinel] = useState<HTMLElement | null>(null);
  const [bottomSentinel, setBottomSentinel] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || (!topSentinel && !bottomSentinel)) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === topSentinel) expandToNewer();
          else if (entry.target === bottomSentinel) expandToOlder();
        }
      },
      { root, rootMargin: cfg.rootMargin }
    );

    if (topSentinel) observer.observe(topSentinel);
    if (bottomSentinel) observer.observe(bottomSentinel);

    return () => observer.disconnect();
  }, [topSentinel, bottomSentinel, scrollContainerRef, expandToNewer, expandToOlder, cfg.rootMargin]);

  const renderedItems = useMemo(
    () => items.slice(windowStart, windowEnd),
    [items, windowStart, windowEnd]
  );

  const jumpToLatest = useCallback(() => {
    setWindowStart(0);
    setWindowEnd(Math.min(cfg.initialTail, items.length));
  }, [items.length, cfg.initialTail]);

  return {
    renderedItems,
    hasOlder: windowEnd < items.length,
    hasNewer: windowStart > 0,
    topSentinelRef: setTopSentinel,
    bottomSentinelRef: setBottomSentinel,
    jumpToLatest,
  };
};
