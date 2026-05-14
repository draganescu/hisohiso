import type { Block } from '../../lib/blocks';
import { ConfidenceDot } from './ConfidenceDot';
import { ButtonsBlockView } from './ButtonsBlock';
import { SwipeBlockView } from './SwipeBlock';
import { SliderBlockView } from './SliderBlock';
import { ChecklistBlockView } from './ChecklistBlock';
import { SortableBlockView } from './SortableBlock';
import { DiffBlockView } from './DiffBlock';
import { FileTreeBlockView } from './FileTreeBlock';
import { TerminalBlockView } from './TerminalBlock';
import { ProgressBlockView } from './ProgressBlock';
import { CodeBlockView } from './CodeBlock';
import { BeforeAfterBlockView } from './BeforeAfterBlock';
import { ErrorBlockView } from './ErrorBlock';
import { ConfirmDangerBlockView } from './ConfirmDangerBlock';
import { CommitBlockView } from './CommitBlock';
import { RunCommandBlockView } from './RunCommandBlock';
import { ThinkingBlockView } from './ThinkingBlock';
import { CostBlockView } from './CostBlock';
import { FilePeekBlockView } from './FilePeekBlock';
import { CarouselBlockView } from './CarouselBlock';
import { LinkPreviewBlockView } from './LinkPreviewBlock';

type RespondFn = (blockId: string, type: string, value: unknown) => void;

interface Props {
  blocks: Block[];
  onRespond: RespondFn;
}

const renderBlock = (block: Block, onRespond: RespondFn) => {
  switch (block.type) {
    case 'buttons':
      return <ButtonsBlockView block={block} onRespond={onRespond as never} />;
    case 'swipe':
      return <SwipeBlockView block={block} onRespond={onRespond as never} />;
    case 'slider':
      return <SliderBlockView block={block} onRespond={onRespond as never} />;
    case 'checklist':
      return <ChecklistBlockView block={block} onRespond={onRespond as never} />;
    case 'sortable':
      return <SortableBlockView block={block} onRespond={onRespond as never} />;
    case 'diff':
      return <DiffBlockView block={block} />;
    case 'file-tree':
      return <FileTreeBlockView block={block} />;
    case 'terminal':
      return <TerminalBlockView block={block} />;
    case 'progress':
      return <ProgressBlockView block={block} />;
    case 'code':
      return <CodeBlockView block={block} />;
    case 'before-after':
      return <BeforeAfterBlockView block={block} />;
    case 'error':
      return <ErrorBlockView block={block} />;
    case 'confirm-danger':
      return <ConfirmDangerBlockView block={block} onRespond={onRespond as never} />;
    case 'commit':
      return <CommitBlockView block={block} onRespond={onRespond as never} />;
    case 'run-command':
      return <RunCommandBlockView block={block} onRespond={onRespond as never} />;
    case 'thinking':
      return <ThinkingBlockView block={block} />;
    case 'cost':
      return <CostBlockView block={block} />;
    case 'file-peek':
      return <FilePeekBlockView block={block} />;
    case 'carousel':
      return <CarouselBlockView block={block} />;
    case 'link-preview':
      return <LinkPreviewBlockView block={block} />;
    default:
      return null;
  }
};

export const BlockRenderer = ({ blocks, onRespond }: Props) => (
  <div className="space-y-1">
    {blocks.map((block, i) => {
      const content = renderBlock(block, onRespond);
      if (!content) return null;
      return (
        <div key={block.id ?? i}>
          {block.confidence && (
            <div className="mb-1 flex items-center gap-1.5">
              <ConfidenceDot level={block.confidence} />
              <span className="text-[11px] text-[#8d816c]">{block.confidence} confidence</span>
            </div>
          )}
          {content}
        </div>
      );
    })}
  </div>
);
