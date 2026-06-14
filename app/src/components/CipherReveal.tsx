import { useEffect, useRef, useState } from 'react';

/**
 * CipherReveal — a purely cosmetic "decrypt" shimmer.
 *
 * The text passed in is ALREADY decrypted plaintext. On first mount we briefly
 * render scrambled hex glyphs that resolve, left-to-right, into the real text.
 * This is window dressing only:
 *   - No network, no persistence, no state beyond this component instance.
 *   - The animation never alters or hides the real text once it settles; the
 *     terminal frame is always exactly `text`.
 *   - prefers-reduced-motion (or a missing rAF / non-browser env) => the real
 *     text is rendered immediately, with no scramble and no timers.
 *
 * Because the scramble is decorative, the real text is also exposed to
 * assistive tech immediately via an aria-label, so screen readers never see
 * the gibberish.
 */

const HEX = '0123456789abcdef';

/** Pick a random hex glyph for a scrambled slot. */
function randomHex(): string {
  return HEX[(Math.random() * HEX.length) | 0]!;
}

/**
 * Subscribe to `prefers-reduced-motion`. Mirrors the matchMedia + 'change'
 * listener pattern already used in lib/theme.ts. Treats SSR / missing
 * matchMedia as "reduced" so we degrade to plain text rather than animate.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(prefersReducedMotion);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

export type CipherRevealProps = {
  /** The already-decrypted plaintext to reveal. */
  text: string;
  /** Total scramble duration in ms (clamped). Default 600. */
  durationMs?: number;
  /**
   * How many characters resolve per "tick" relative to length. Higher = faster
   * settle of individual glyphs. Default reveals across the full duration.
   */
  className?: string;
  /** Optional element tag. Defaults to a <span>. */
  as?: 'span' | 'div';
};

/**
 * Run the reveal as a hook so callers can drive their own element if needed.
 * Returns the current display string. Always ends on `text`.
 */
export function useCipherReveal(text: string, durationMs = 600): string {
  const reduced = useReducedMotion();
  // Start already-resolved when motion is reduced so first paint is the truth.
  const [display, setDisplay] = useState<string>(() => (prefersReducedMotion() ? text : maskAll(text)));
  const rafRef = useRef<number | null>(null);
  // Only the FIRST mount per text value animates; later re-renders are static.
  const startedFor = useRef<string | null>(null);

  useEffect(() => {
    // Reduced motion (or no rAF): show the real text immediately, no timers.
    if (reduced || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      setDisplay(text);
      return;
    }

    // Re-run the shimmer whenever the underlying text changes.
    if (startedFor.current === text) {
      setDisplay(text);
      return;
    }
    startedFor.current = text;

    const chars = Array.from(text);
    const total = chars.length;
    if (total === 0) {
      setDisplay('');
      return;
    }

    const duration = Math.max(120, Math.min(2000, durationMs));
    const start = performance.now();
    let cancelled = false;

    const frame = (now: number) => {
      if (cancelled) return;
      const progress = Math.min(1, (now - start) / duration);
      // How many leading characters have fully resolved.
      const resolved = Math.floor(progress * total);
      let out = '';
      for (let i = 0; i < total; i += 1) {
        const ch = chars[i]!;
        // Whitespace passes through so layout doesn't jump.
        if (i < resolved || ch.trim() === '') {
          out += ch;
        } else {
          out += randomHex();
        }
      }
      setDisplay(out);

      if (progress < 1) {
        rafRef.current = window.requestAnimationFrame(frame);
      } else {
        // GUARANTEE: terminal frame is the real, unmodified text.
        setDisplay(text);
      }
    };

    rafRef.current = window.requestAnimationFrame(frame);

    return () => {
      cancelled = true;
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Safety: never leave the user staring at ciphertext.
      setDisplay(text);
    };
  }, [text, durationMs, reduced]);

  return display;
}

/** Replace every non-whitespace glyph with a random hex char. */
function maskAll(text: string): string {
  let out = '';
  for (const ch of Array.from(text)) {
    out += ch.trim() === '' ? ch : randomHex();
  }
  return out;
}

/**
 * Component wrapper. Renders `text` with a one-shot decrypt shimmer.
 * The animating glyphs are aria-hidden; the real text is always available to
 * assistive tech via aria-label.
 */
export default function CipherReveal({
  text,
  durationMs = 600,
  className,
  as = 'span'
}: CipherRevealProps) {
  const display = useCipherReveal(text, durationMs);
  const animating = display !== text;
  const Tag = as;

  return (
    <Tag
      className={['cipher-reveal', animating ? 'cipher-reveal--active' : '', className]
        .filter(Boolean)
        .join(' ')}
      // Real text for screen readers, regardless of the visual scramble.
      aria-label={text}
    >
      <span aria-hidden={animating || undefined}>{display}</span>
    </Tag>
  );
}
