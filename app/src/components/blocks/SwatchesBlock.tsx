import type { SwatchesBlock as SwatchesBlockType } from '../../lib/blocks';

interface Props {
  block: SwatchesBlockType;
}

// Defense in depth: the wire validator already strips non-hex values, but the
// renderer never trusts a color enough to drop it into an inline style without
// re-checking. Anything that isn't a literal hex is shown as a neutral chip.
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const safeHex = (hex: string): string | null => (HEX_RE.test(hex.trim()) ? hex.trim() : null);

export const SwatchesBlockView = ({ block }: Props) => {
  const schemes = block.schemes ?? [];
  if (schemes.length === 0) return null;

  return (
    <div className="mt-3 rounded-2xl border border-rule bg-surface px-4 py-3">
      {block.title && <p className="mb-3 text-sm font-semibold text-ink">{block.title}</p>}
      <div className="space-y-4">
        {schemes.map((scheme, si) => (
          <div key={si}>
            {(scheme.name || scheme.note) && (
              <div className="mb-2">
                {scheme.name && <p className="text-sm font-medium text-ink">{scheme.name}</p>}
                {scheme.note && <p className="text-[0.6875rem] leading-tight text-ink-dim">{scheme.note}</p>}
              </div>
            )}
            <div className="flex flex-wrap gap-2.5">
              {scheme.colors.map((color, ci) => {
                const hex = safeHex(color.hex);
                return (
                  <div key={ci} className="w-[4.5rem] min-w-0">
                    {hex ? (
                      <div
                        className="h-14 w-full rounded-xl border border-rule"
                        style={{ backgroundColor: hex }}
                        title={color.name ? `${color.name} ${hex}` : hex}
                      />
                    ) : (
                      <div className="flex h-14 w-full items-center justify-center rounded-xl border border-dashed border-ink-fade text-[0.625rem] text-ink-dim">
                        n/a
                      </div>
                    )}
                    {color.name && <p className="mt-1 truncate text-[0.6875rem] font-medium leading-tight text-ink-soft">{color.name}</p>}
                    <p className="truncate font-mono text-[0.625rem] leading-tight text-ink-dim">{hex ?? color.hex}</p>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
