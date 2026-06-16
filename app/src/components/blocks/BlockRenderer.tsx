import { useState, useCallback, useMemo } from 'react';
import type { Block, ProgressBlock as ProgressBlockType, RunCommandBlock as RunCommandBlockType } from '../../lib/blocks';
import { sanitizeBlocksForRender } from '../../lib/block-validation';
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
import { ListBlockView } from './ListBlock';
import { ProseBlockView } from './ProseBlock';
import { LabelBlockView } from './LabelBlock';
import { SwatchesBlockView } from './SwatchesBlock';
import { SecretBlockView } from './SecretBlock';

/** One block's selection. The renderer always hands back an array so a single
 *  agent message that carries several interactive blocks is answered with ONE
 *  outgoing message instead of N racing ones. */
export type BlockResponseInput = { blockId: string; type: string; value: unknown };
type RespondFn = (responses: BlockResponseInput[]) => void;
type PendingSelection = { type: string; value: unknown };

interface Props {
  blocks: Block[];
  onRespond: RespondFn;
  /** Map of progress-block id -> latest version seen anywhere in the thread.
   * Lets older messages re-render with current progress instead of a stale snapshot. */
  progressOverrides?: Record<string, ProgressBlockType>;
}

/** Blocks that auto-submit on selection (have their own safety mechanisms) */
const isAutoSubmit = (block: Block): boolean => {
  if (block.type === 'confirm-danger') return true;
  if (block.type === 'secret') return true; // send on its own submit; never sit in the shared pending map
  if (block.type === 'run-command' && (block as RunCommandBlockType).risk === 'dangerous') return true;
  return false;
};

export const BlockRenderer = ({ blocks, onRespond, progressOverrides }: Props) => {
  const safeBlocks = useMemo(() => sanitizeBlocksForRender(blocks), [blocks]);
  const [pending, setPending] = useState<Map<string, PendingSelection>>(new Map());
  const [submittedIds, setSubmittedIds] = useState<Set<string>>(new Set());

  const handleSelect = useCallback((blockId: string, type: string, value: unknown) => {
    // Auto-submit blocks with built-in safety (confirm-danger, dangerous run-command)
    const block = safeBlocks.find(b => b.id === blockId);
    if (block && isAutoSubmit(block)) {
      onRespond([{ blockId, type, value }]);
      setSubmittedIds(prev => new Set([...prev, blockId]));
      return;
    }

    // null value means deselect
    if (value === null) {
      setPending(prev => {
        const next = new Map(prev);
        next.delete(blockId);
        return next;
      });
    } else {
      setPending(prev => new Map(prev).set(blockId, { type, value }));
    }
  }, [safeBlocks, onRespond]);

  const submitAll = useCallback(() => {
    if (pending.size === 0) return;
    // Send every pending selection as ONE batch so the agent receives a single
    // message. Looping onRespond() here used to emit N separate messages that
    // raced — the first won and the rest queued behind it.
    const responses: BlockResponseInput[] = Array.from(pending, ([blockId, { type, value }]) => ({
      blockId,
      type,
      value,
    }));
    onRespond(responses);
    setSubmittedIds(prev => {
      const next = new Set(prev);
      for (const blockId of pending.keys()) next.add(blockId);
      return next;
    });
    setPending(new Map());
  }, [pending, onRespond]);

  const renderBlock = (block: Block) => {
    const isSubmitted = block.id ? submittedIds.has(block.id) : false;

    switch (block.type) {
      case 'buttons':
        return <ButtonsBlockView block={block} onSelect={handleSelect as never} submitted={isSubmitted} />;
      case 'swipe':
        return <SwipeBlockView block={block} onSelect={handleSelect as never} submitted={isSubmitted} />;
      case 'slider':
        return <SliderBlockView block={block} onSelect={handleSelect as never} submitted={isSubmitted} />;
      case 'checklist':
        return <ChecklistBlockView block={block} onSelect={handleSelect as never} submitted={isSubmitted} />;
      case 'sortable':
        return <SortableBlockView block={block} onSelect={handleSelect as never} submitted={isSubmitted} />;
      case 'confirm-danger':
        return <ConfirmDangerBlockView block={block} onSelect={handleSelect as never} submitted={isSubmitted} />;
      case 'commit':
        return <CommitBlockView block={block} onSelect={handleSelect as never} submitted={isSubmitted} />;
      case 'run-command':
        return <RunCommandBlockView block={block} onSelect={handleSelect as never} submitted={isSubmitted} />;
      case 'diff':
        return <DiffBlockView block={block} />;
      case 'file-tree':
        return <FileTreeBlockView block={block} />;
      case 'terminal':
        return <TerminalBlockView block={block} />;
      case 'progress': {
        const latest = block.id && progressOverrides?.[block.id];
        return <ProgressBlockView block={latest || block} />;
      }
      case 'code':
        return <CodeBlockView block={block} />;
      case 'before-after':
        return <BeforeAfterBlockView block={block} />;
      case 'error':
        return <ErrorBlockView block={block} />;
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
      case 'list':
        return <ListBlockView block={block} />;
      case 'prose':
        return <ProseBlockView block={block} />;
      case 'label':
        return <LabelBlockView block={block} />;
      case 'swatches':
        return <SwatchesBlockView block={block} />;
      case 'secret':
        return <SecretBlockView block={block} onSelect={handleSelect as never} submitted={isSubmitted} />;
      default:
        return null;
    }
  };

  return (
    <div className="space-y-1">
      {safeBlocks.map((block, i) => {
        if (!block || typeof block !== 'object' || !block.type) return null;
        let content: React.ReactNode;
        try {
          content = renderBlock(block);
        } catch {
          content = (
            <div className="rounded-xl border border-dashed border-ink-fade bg-surface px-4 py-2 text-xs text-ink-dim">
              Could not render {block.type} block
            </div>
          );
        }
        if (!content) return null;
        return (
          <div key={block.id ?? i}>
            {block.confidence && (
              <div className="mb-1 flex items-center gap-1.5">
                <ConfidenceDot level={block.confidence} />
                <span className="text-[0.6875rem] text-ink-dim">{block.confidence} confidence</span>
              </div>
            )}
            {content}
          </div>
        );
      })}
      {pending.size > 0 && (
        <button
          type="button"
          onClick={submitAll}
          className="mt-4 w-full rounded-full bg-filled py-3 text-sm font-semibold text-on-ink active:bg-[#c04d27]"
        >
          Send{pending.size > 1 ? ` (${pending.size})` : ''}
        </button>
      )}
    </div>
  );
};
