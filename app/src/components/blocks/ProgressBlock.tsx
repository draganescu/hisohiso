import type { ProgressBlock as ProgressBlockType } from '../../lib/blocks';

interface Props {
  block: ProgressBlockType;
}

const statusStyles: Record<string, { dot: string; text: string }> = {
  done: { dot: 'bg-green-500', text: 'text-ink' },
  active: { dot: 'bg-ink animate-pulse', text: 'font-semibold text-ink' },
  pending: { dot: 'bg-ink-fade', text: 'text-ink-dim' },
  failed: { dot: 'bg-red-500', text: 'text-red-700' },
};

export const ProgressBlockView = ({ block }: Props) => (
  <div className="mt-3">
    {block.title && <p className="text-sm font-semibold">{block.title}</p>}
    <div className="mt-2 space-y-0">
      {block.steps.map((step, i) => {
        const style = statusStyles[step.status] || statusStyles.pending;
        const isLast = i === block.steps.length - 1;
        return (
          <div key={i} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div className={`mt-1 h-3 w-3 shrink-0 rounded-full ${style.dot}`} />
              {!isLast && <div className="w-px flex-1 bg-ink-fade" />}
            </div>
            <div className={`pb-4 text-sm ${style.text}`}>
              {step.status === 'done' && <span className="mr-1">&#10003;</span>}
              {step.status === 'failed' && <span className="mr-1">&#10007;</span>}
              {step.label}
            </div>
          </div>
        );
      })}
    </div>
  </div>
);
