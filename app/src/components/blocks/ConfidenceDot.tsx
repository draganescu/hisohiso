import type { Confidence } from '../../lib/blocks';

const colors: Record<Confidence, string> = {
  high: 'bg-green-500',
  medium: 'bg-yellow-500',
  low: 'bg-red-500',
};

export const ConfidenceDot = ({ level }: { level: Confidence }) => (
  <span className={`inline-block h-2 w-2 rounded-full ${colors[level]}`} title={`Confidence: ${level}`} />
);
