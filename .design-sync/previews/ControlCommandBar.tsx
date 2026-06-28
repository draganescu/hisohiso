import { ControlCommandBar } from 'hisohiso-app';

// The bar is `position: fixed` to the viewport bottom. A `transform` on the
// wrapper establishes a containing block for fixed descendants, so the bar
// lands inside the card instead of escaping to the bottom of the capture.
const frame = { maxWidth: 380, margin: '0 auto' };
const stage = {
  position: 'relative' as const,
  transform: 'translateZ(0)',
  minHeight: 96,
  padding: 12,
};

export const NoAgents = () => (
  <div style={frame}>
    <div style={stage}>
      <ControlCommandBar agentCount={0} onSpawn={() => {}} onAgents={() => {}} />
    </div>
  </div>
);

export const ThreeAgents = () => (
  <div style={frame}>
    <div style={stage}>
      <ControlCommandBar agentCount={3} onSpawn={() => {}} onAgents={() => {}} />
    </div>
  </div>
);
