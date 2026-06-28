import { Avatar } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };
const row = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  flexWrap: 'wrap' as const,
};

// A spread of seeds → distinct riso-ink tints + derived initials. Voluntary
// handles and agent task names, the kinds of strings Avatar is seeded with in
// the app.
export const Seeds = () => (
  <div style={frame}>
    <div style={row}>
      <Avatar seed="alex" />
      <Avatar seed="maya" />
      <Avatar seed="daemon · mbp-16" />
      <Avatar seed="fix-flaky-test" />
      <Avatar seed="río" />
      <Avatar seed="a1f3c2" />
    </div>
  </div>
);

// All three sizes on one seed so the scale relationship reads at a glance.
export const Sizes = () => (
  <div style={frame}>
    <div style={row}>
      <Avatar seed="maya" size="sm" />
      <Avatar seed="maya" size="md" />
      <Avatar seed="maya" size="lg" />
    </div>
  </div>
);
