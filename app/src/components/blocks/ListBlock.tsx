import type { ListBlock as ListBlockType } from '../../lib/blocks';

interface Props {
  block: ListBlockType;
}

const markerFor = (style: ListBlockType['style'], index: number): string => {
  if (style === 'numbered') return `${index + 1}.`;
  if (style === 'check') return '✓';
  return '•';
};

export const ListBlockView = ({ block }: Props) => {
  const style = block.style || 'bullet';
  return (
    <div className="mt-3 rounded-2xl border border-[#d5c8b2] bg-[#fdf9f2] px-4 py-3">
      {block.title && <p className="mb-2 text-sm font-semibold text-[#171613]">{block.title}</p>}
      <ul className="space-y-1.5">
        {block.items.map((item, i) => (
          <li key={i} className="flex gap-2 text-sm leading-6 text-[#3f3529]">
            <span className="shrink-0 select-none text-[#8d816c]">{markerFor(style, i)}</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};
