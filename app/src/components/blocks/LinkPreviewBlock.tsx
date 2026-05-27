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
      {domain && <p className="text-xs font-medium text-[#9a9a9a]">{domain}</p>}
      <p className="mt-1 text-sm font-semibold text-[#0a0a0a]">{block.title}</p>
      {block.description && (
        <p className="mt-1 text-sm leading-5 text-[#6b6b6b]">{block.description}</p>
      )}
    </>
  );

  if (!href) {
    return (
      <div
        className="mt-3 block rounded-2xl border border-dashed border-[#c4c4c4] bg-[#ffffff] p-4"
        title="Link blocked: unsafe URL scheme"
      >
        {body}
        <p className="mt-2 text-xs font-medium text-[#0a0a0a]">Link blocked — unsafe URL scheme</p>
      </div>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-3 block rounded-2xl border border-[#c4c4c4] bg-[#ffffff] p-4 no-underline transition hover:border-[#0a0a0a]"
      onClick={(e) => e.stopPropagation()}
    >
      {body}
    </a>
  );
};
