import { useState } from 'react';
import type { CostBlock as CostBlockType } from '../../lib/blocks';

interface Props {
  block: CostBlockType;
}

const fmt = (n: number) => n.toLocaleString();
const fmtCost = (n: number) => `$${n.toFixed(3)}`;

export const CostBlockView = ({ block }: Props) => {
  const [open, setOpen] = useState(false);

  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      className="mt-2 inline-flex flex-col items-start rounded-xl border border-[#e8e0d0] bg-[#f9f5ee] px-3 py-1.5 text-left"
    >
      <span className="text-xs text-[#8d816c]">
        {block.total_tokens != null && <>{fmt(block.total_tokens)} tokens</>}
        {block.estimated_cost != null && <> &middot; {fmtCost(block.estimated_cost)}</>}
      </span>
      {open && (
        <span className="mt-1 space-x-3 text-xs text-[#a89e90]">
          {block.input_tokens != null && <span>In: {fmt(block.input_tokens)}</span>}
          {block.output_tokens != null && <span>Out: {fmt(block.output_tokens)}</span>}
          {block.session_total_cost != null && <span>Session: {fmtCost(block.session_total_cost)}</span>}
        </span>
      )}
    </button>
  );
};
