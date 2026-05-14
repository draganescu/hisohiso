import type { LinkPreviewBlock as LinkPreviewBlockType } from '../../lib/blocks';

interface Props {
  block: LinkPreviewBlockType;
}

export const LinkPreviewBlockView = ({ block }: Props) => (
  <a
    href={block.url}
    target="_blank"
    rel="noopener noreferrer"
    className="mt-3 block rounded-2xl border border-[#d5c8b2] bg-[#fdf9f2] p-4 no-underline transition hover:border-[#d9592f]"
    onClick={(e) => e.stopPropagation()}
  >
    <p className="text-xs font-medium text-[#8d816c]">{block.domain || new URL(block.url).hostname}</p>
    <p className="mt-1 text-sm font-semibold text-[#171613]">{block.title}</p>
    {block.description && (
      <p className="mt-1 text-sm leading-5 text-[#5d564d]">{block.description}</p>
    )}
  </a>
);
