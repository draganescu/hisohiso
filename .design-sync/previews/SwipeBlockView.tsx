import { SwipeBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };
const noop = () => {};

export const ApproachTradeoff = () => (
  <div style={frame}>
    <SwipeBlockView
      onSelect={noop}
      submitted={false}
      block={{
        type: 'swipe',
        id: 'cache-approach',
        prompt: 'Rate each caching approach for the room list:',
        cards: [
          {
            value: 'in-memory',
            title: 'In-memory LRU',
            body: 'Hold the last 50 rooms in a process-local LRU and rebuild on cold start.',
            pros: ['Zero extra infra', 'Sub-millisecond reads'],
            cons: ['Lost on restart', 'No cross-instance sharing'],
          },
          {
            value: 'redis',
            title: 'Shared Redis cache',
            body: 'Store the serialized room list in Redis with a 30s TTL across all instances.',
            pros: ['Survives restarts', 'Consistent across nodes'],
            cons: ['One more service to run', 'Network round-trip per miss'],
          },
        ],
      }}
    />
  </div>
);

export const MigrationChoice = () => (
  <div style={frame}>
    <SwipeBlockView
      onSelect={noop}
      submitted={false}
      block={{
        type: 'swipe',
        id: 'db-migration',
        prompt: 'Which rollout plan should I draft for the schema change?',
        cards: [
          {
            value: 'big-bang',
            title: 'Single migration',
            body: 'Add the column, backfill, and flip reads in one deploy during the maintenance window.',
            pros: ['Done in one step', 'No dual-write code'],
            cons: ['Locks the table while backfilling', 'Hard to roll back mid-way'],
          },
          {
            value: 'expand-contract',
            title: 'Expand / contract',
            body: 'Add the nullable column, dual-write for a release, backfill async, then drop the old path.',
            pros: ['Zero-downtime', 'Reversible at every stage'],
            cons: ['Three deploys to finish', 'Temporary dual-write branch'],
          },
        ],
      }}
    />
  </div>
);
