import { useState } from 'react';
import type { FileTreeBlock as FileTreeBlockType, FileTreeNode } from '../../lib/blocks';

const statusIcon: Record<string, string> = {
  added: '+',
  modified: '~',
  deleted: '-',
  renamed: '→',
};

const statusColor: Record<string, string> = {
  added: 'text-green-600',
  modified: 'text-yellow-600',
  deleted: 'text-red-500',
  renamed: 'text-blue-500',
};

const TreeNode = ({ node, depth }: { node: FileTreeNode; depth: number }) => {
  const [open, setOpen] = useState(true);
  const isDir = node.children && node.children.length > 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => isDir && setOpen(!open)}
        className="flex w-full items-center gap-2 py-1 text-left text-sm hover:bg-[#f4ede1]"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {isDir && <span className="text-xs text-[#8d816c]">{open ? '▾' : '▸'}</span>}
        <span className={isDir ? 'font-semibold text-[#171613]' : 'text-[#3f3529]'}>
          {node.path}
        </span>
        {node.status && (
          <span className={`ml-auto pr-2 font-mono text-xs font-bold ${statusColor[node.status] || ''}`}>
            {statusIcon[node.status] || ''}
          </span>
        )}
      </button>
      {isDir && open && node.children!.map((child, i) => (
        <TreeNode key={i} node={child} depth={depth + 1} />
      ))}
    </div>
  );
};

interface Props {
  block: FileTreeBlockType;
}

export const FileTreeBlockView = ({ block }: Props) => (
  <div className="mt-3 overflow-hidden rounded-2xl border border-[#d5c8b2] bg-[#fdf9f2]">
    {block.summary && (
      <div className="border-b border-[#e8e0d0] px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-[#8d816c]">
        {block.summary}
      </div>
    )}
    <div className="py-1">
      {block.nodes.map((node, i) => (
        <TreeNode key={i} node={node} depth={0} />
      ))}
    </div>
  </div>
);
