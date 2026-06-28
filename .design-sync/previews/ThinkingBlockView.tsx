import { ThinkingBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const RaceConditionReasoning = () => (
  <div style={frame}>
    <ThinkingBlockView
      block={{
        type: 'thinking',
        summary: 'Reasoning about the flaky presence test',
        content:
          'The test fails about 1 in 8 runs, always on the assertion that exactly one poll timer is live. ' +
          'Looking at reconnect(), it calls setInterval again without clearing the previous timer, so a fast ' +
          'reconnect leaves two timers racing. The fix is to guard with clearInterval before re-arming, and to ' +
          'use POLL_MS instead of the hardcoded 1000 so the test and prod share one constant.',
      }}
    />
  </div>
);

export const PlanningReasoning = () => (
  <div style={frame}>
    <ThinkingBlockView
      block={{
        type: 'thinking',
        summary: 'Deciding how to scope the auth refactor',
        content:
          'The login path and the token-refresh path both reimplement session validation slightly differently, ' +
          'which is why refresh sometimes accepts a session login already rejected. I want to extract a single ' +
          'validateSession() and route both callers through it, but I should land the extraction with no behavior ' +
          'change first, get a green test run, and only then tighten the expiry check in a separate commit.',
      }}
    />
  </div>
);
