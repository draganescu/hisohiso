import { ThemeToggle } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };
const cell = { padding: 16, display: 'flex', justifyContent: 'center' };

export const Segmented = () => (
  <div style={frame}>
    <div style={cell}>
      <ThemeToggle variant="segmented" />
    </div>
  </div>
);

export const Pill = () => (
  <div style={frame}>
    <div style={cell}>
      <ThemeToggle variant="pill" />
    </div>
  </div>
);
