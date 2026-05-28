import type { LabelBlock as LabelBlockType } from '../../lib/blocks';

interface Props {
  block: LabelBlockType;
}

export const LabelBlockView = ({ block }: Props) => (
  <div className="mt-4 mb-1 flex items-center gap-2">
    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8d816c]">
      {block.text}
    </span>
    <div className="h-px flex-1 bg-[#e8e0d0]" />
  </div>
);
