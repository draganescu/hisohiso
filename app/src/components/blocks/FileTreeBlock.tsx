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
        className="flex w-full items-center gap-2 py-1 text-left text-sm hover:bg-[#efefec]"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {isDir && <span className="text-xs text-[#9a9a9a]">{open ? '▾' : '▸'}</span>}
        <span className={isDir ? 'font-semibold text-[#0a0a0a]' : 'text-[#1a1a1a]'}>
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
  <div className="mt-3 overflow-hidden rounded-2xl border border-[#c4c4c4] bg-[#ffffff]">
    {block.summary && (
      <div className="border-b border-[#e8e0d0] px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-[#9a9a9a]">
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
