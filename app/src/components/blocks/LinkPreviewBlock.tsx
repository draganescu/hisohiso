import type { LinkPreviewBlock as LinkPreviewBlockType } from '../../lib/blocks';
import { safeHref } from '../../lib/safeHref';

interface Props {
  block: LinkPreviewBlockType;
}

const deriveDomain = (block: LinkPreviewBlockType, href: string | null): string | null => {
  if (block.domain) return block.domain;
  if (!href) return null;
  try {
    return new URL(href, 'https://invalid.local/').hostname || null;
  } catch {
    return null;
  }
};

export const LinkPreviewBlockView = ({ block }: Props) => {
  const href = safeHref(block.url);
  const domain = deriveDomain(block, href);

  const body = (
    <>
      {domain && <p className="text-xs font-medium text-ink-dim">{domain}</p>}
      <p className="mt-1 text-sm font-semibold text-ink">{block.title}</p>
      {block.description && (
        <p className="mt-1 text-sm leading-5 text-ink-soft">{block.description}</p>
      )}
    </>
  );

  if (!href) {
    return (
      <div
        className="mt-3 block rounded-2xl border border-dashed border-ink-fade bg-surface p-4"
        title="Link blocked: unsafe URL scheme"
      >
        {body}
        <p className="mt-2 text-xs font-medium text-ink">Link blocked — unsafe URL scheme</p>
      </div>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-3 block rounded-2xl border border-ink-fade bg-surface p-4 no-underline transition hover:border-ink"
      onClick={(e) => e.stopPropagation()}
    >
      {body}
    </a>
  );
};
