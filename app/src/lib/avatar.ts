// Deterministic two-letter label + riso-ink color derived from a seed string.
//
// PRIVACY CONTRACT (read before changing anything here):
//   - Pure, local, synchronous. NO network, NO storage, NO persistence.
//   - The SEED is supplied by the caller and must be one of:
//       1. the person's VOLUNTARILY-set handle (preferred), or
//       2. their per-room EPHEMERAL participant id (fallback).
//     It must NEVER be a stable cross-room or device id — that would let the
//     same person be fingerprinted/correlated across rooms. This module does
//     not know or care which kind of seed it got; it just hashes the string.
//   - No PII is read, written, or transmitted. The output is two letters and a
//     CSS-var color name — nothing that leaks identity on its own.
//
// Determinism matters: the same seed renders the same initials + color on every
// reload and on every device in the room, with zero coordination. The hash is
// the only shared input.

// The riso palette, expressed as the CSS custom properties already defined in
// styles.css (light + dark variants live there). We pick a var() name rather
// than a hex literal so the avatar tracks the active theme automatically.
export const AVATAR_PALETTE = [
  '--pink',
  '--blue',
  '--lime',
  '--tang',
  '--accent',
] as const;

export type AvatarColorVar = (typeof AVATAR_PALETTE)[number];

export type AvatarStyle = {
  /** Up to two uppercase letters, e.g. "AD". */
  initials: string;
  /** The chosen palette entry as a CSS custom-property name, e.g. "--blue". */
  colorVar: AvatarColorVar;
  /** Ready-to-use `var(--blue)` string for inline styles / borders / fills. */
  color: string;
};

// FNV-1a 32-bit. Small, dependency-free, and stable across runtimes — good
// enough for spreading seeds across a 5-color palette and is NOT used for
// anything security-sensitive.
const hashSeed = (seed: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    // h *= 16777619, kept in 32-bit unsigned space via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

// Strip everything that isn't a letter or digit, collapse runs of whitespace,
// and split into "words" so we can prefer first-letter-of-each-word initials.
const toWords = (raw: string): string[] =>
  raw
    .trim()
    .split(/[\s._\-/]+/u)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length > 0);

/**
 * Derive up to two uppercase letters from a seed.
 *
 * - "Andrei Draganescu" -> "AD"  (first letter of the first two words)
 * - "andrei"            -> "AN"  (first two letters of the single word)
 * - "x9f3a2"            -> "X9"  (ephemeral participant id: just the first two)
 * - ""                  -> "??"  (graceful, never throws)
 */
export const deriveInitials = (seed: string): string => {
  const words = toWords(seed);
  if (words.length === 0) return '??';
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
};

/** Pick a palette color deterministically from the seed. */
export const deriveColorVar = (seed: string): AvatarColorVar =>
  AVATAR_PALETTE[hashSeed(seed) % AVATAR_PALETTE.length];

/**
 * One-shot helper: everything a renderer needs from a seed.
 *
 * The seed is the caller's responsibility — pass a voluntary handle when one
 * exists, otherwise the per-room ephemeral participant id. Never a stable
 * cross-room/device id.
 */
export const deriveAvatar = (seed: string): AvatarStyle => {
  const safe = seed ?? '';
  const colorVar = deriveColorVar(safe);
  return {
    initials: deriveInitials(safe),
    colorVar,
    color: `var(${colorVar})`,
  };
};
