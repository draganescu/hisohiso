import { useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'hisohiso.theme';

const readChoice = (): ThemeChoice => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {}
  return 'system';
};

const systemPrefersDark = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;

const resolve = (choice: ThemeChoice): ResolvedTheme =>
  choice === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : choice;

const apply = (resolved: ResolvedTheme) => {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  // Match the live --theme-color CSS var so the browser chrome / PWA splash
  // follows the active palette.
  const themeColor = getComputedStyle(root).getPropertyValue('--theme-color').trim();
  if (themeColor) {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
  }
};

export const useTheme = () => {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readChoice());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(readChoice()));

  useEffect(() => {
    const r = resolve(choice);
    setResolved(r);
    apply(r);
    try {
      localStorage.setItem(STORAGE_KEY, choice);
    } catch {}
  }, [choice]);

  useEffect(() => {
    if (choice !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const r: ResolvedTheme = mq.matches ? 'dark' : 'light';
      setResolved(r);
      apply(r);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [choice]);

  return {
    choice,
    resolved,
    setChoice: (c: ThemeChoice) => setChoiceState(c),
    cycle: () => setChoiceState((c) => (c === 'system' ? 'light' : c === 'light' ? 'dark' : 'system'))
  };
};
