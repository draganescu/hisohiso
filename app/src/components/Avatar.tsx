import { useMemo } from 'react';
import { deriveAvatar, type AvatarStyle } from '../lib/avatar';

// Presentational riso-ink avatar: a tinted disc with up to two letters.
//
// PRIVACY: this component renders ONLY what `deriveAvatar` returns from the
// seed the caller passes. It performs no lookups, no network, no storage. The
// caller owns the seed choice (voluntary handle, else per-room ephemeral id —
// never a stable cross-room/device id). See lib/avatar.ts for the full contract.

/**
 * Derive avatar style once per seed. Thin memoized wrapper over `deriveAvatar`
 * so a parent can read {initials,color} without re-deriving every render.
 */
export const useAvatar = (seed: string): AvatarStyle =>
  useMemo(() => deriveAvatar(seed), [seed]);

export type AvatarSize = 'sm' | 'md' | 'lg';

export type AvatarProps = {
  /**
   * Voluntary handle if present, otherwise the per-room ephemeral participant
   * id. Never a stable cross-room or device identifier.
   */
  seed: string;
  size?: AvatarSize;
  /** Accessible label; falls back to the derived initials. */
  title?: string;
  className?: string;
};

const SIZE_CLASSES: Record<AvatarSize, string> = {
  sm: 'h-7 w-7 text-[0.65rem]',
  md: 'h-9 w-9 text-xs',
  lg: 'h-12 w-12 text-sm',
};

const Avatar = ({ seed, size = 'md', title, className }: AvatarProps) => {
  const { initials, color } = useAvatar(seed);

  return (
    <span
      role="img"
      aria-label={title ?? initials}
      title={title}
      className={
        'inline-flex select-none items-center justify-center rounded-full ' +
        'font-mono font-semibold uppercase leading-none tracking-tight ' +
        'text-on-ink ' +
        SIZE_CLASSES[size] +
        (className ? ' ' + className : '')
      }
      style={{
        backgroundColor: color,
        // Subtle riso gloss + a hairline tint border, matching primary surfaces.
        backgroundImage:
          'linear-gradient(176deg, color-mix(in srgb, ' +
          color +
          ' 78%, #fff) 0%, ' +
          color +
          ' 60%)',
        border: '1px solid color-mix(in srgb, ' + color + ' 60%, transparent)',
      }}
    >
      {initials}
    </span>
  );
};

export default Avatar;
