// Tailwind config used only by /design-sync to compile the design-system
// stylesheet (ds-dist/ds-styles.css). Same theme/tokens as the app, but the
// content scan also covers the authored preview cards so any utility classes
// used there are present in the synced CSS.
import base from './tailwind.config.js';

export default {
  ...base,
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../.design-sync/previews/**/*.{ts,tsx,jsx}',
  ],
};
