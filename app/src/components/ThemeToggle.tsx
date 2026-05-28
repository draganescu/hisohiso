import { useTheme, type ThemeChoice } from '../lib/theme';

const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
];

type Props = {
  // 'segmented' renders a labeled 3-state pill (for settings/menu panels).
  // 'pill' renders a single compact button that cycles (for header strips).
  variant?: 'segmented' | 'pill';
};

const ThemeToggle = ({ variant = 'segmented' }: Props) => {
  const { choice, resolved, setChoice, cycle } = useTheme();

  if (variant === 'pill') {
    const label = choice === 'system' ? `Auto · ${resolved}` : choice;
    return (
      <button
        type="button"
        onClick={cycle}
        className="rounded-full border border-rule bg-surface px-3 py-1 text-xs font-medium capitalize text-ink-soft transition hover:border-ink hover:text-ink"
        aria-label={`Theme: ${label}. Click to cycle.`}
      >
        {label}
      </button>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex rounded-full border border-rule bg-surface p-0.5"
    >
      {OPTIONS.map((opt) => {
        const active = choice === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setChoice(opt.value)}
            className={
              'rounded-full px-3 py-1 text-xs font-medium transition ' +
              (active
                ? 'bg-filled text-on-ink'
                : 'text-ink-soft hover:text-ink')
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
};

export default ThemeToggle;
