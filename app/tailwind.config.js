/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        ink: 'var(--ink)',
        'ink-soft': 'var(--ink-soft)',
        'ink-dim': 'var(--ink-dim)',
        'ink-fade': 'var(--ink-fade)',
        rule: 'var(--rule)',
        'rule-soft': 'var(--rule-soft)',
        danger: 'var(--danger)',
        'danger-soft': 'var(--danger-soft)',
        'on-ink': 'var(--on-ink)',
        filled: 'var(--filled)',
        overlay: 'var(--overlay)',
        'overlay-soft': 'var(--overlay-soft)',
        accent: 'var(--accent)',
        'accent-strong': 'var(--accent-strong)',
        'accent-soft': 'var(--accent-soft)',
        success: 'var(--success)',
        pink: 'var(--pink)',
        blue: 'var(--blue)',
        lime: 'var(--lime)',
        tang: 'var(--tang)'
      },
      fontFamily: {
        display: ['"Bricolage Grotesque"', 'system-ui', 'sans-serif'],
        mono: ['"Space Mono"', '"IBM Plex Mono"', 'monospace']
      }
    }
  },
  plugins: []
};
