import { AppLockSettings } from 'hisohiso-app';

// Reads its config from localStorage (defaults to `{ enabled: true }`) and
// renders the standalone settings card.
const frame = { maxWidth: 380, margin: '0 auto' };

export const SettingsCard = () => (
  <div style={frame}>
    <AppLockSettings />
  </div>
);
