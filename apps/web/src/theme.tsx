import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './editor-controls.js';

type Theme = 'light' | 'dark';
const storageKey = 'herd.theme';
const preference = '(prefers-color-scheme: dark)';
const ThemeContext = createContext<{ theme: Theme; toggle(): void } | null>(null);

function storedTheme(): Theme | undefined {
  try {
    const value = localStorage.getItem(storageKey);
    if (value === 'light' || value === 'dark') return value;
  } catch {
    // Browser storage can be disabled.
  }
}

const systemTheme = (): Theme => window.matchMedia(preference).matches ? 'dark' : 'light';

export function initializeTheme() {
  document.documentElement.dataset.theme = storedTheme() ?? systemTheme();
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState(storedTheme);
  const [system, setSystem] = useState(systemTheme);
  const theme = choice ?? system;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const media = window.matchMedia(preference);
    const updateSystem = () => setSystem(systemTheme());
    const updateChoice = (event: StorageEvent) => {
      if (!event.key || event.key === storageKey) setChoice(storedTheme());
    };
    media.addEventListener('change', updateSystem);
    window.addEventListener('storage', updateChoice);
    return () => {
      media.removeEventListener('change', updateSystem);
      window.removeEventListener('storage', updateChoice);
    };
  }, []);
  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setChoice(next);
    try { localStorage.setItem(storageKey, next); } catch { /* Keep the current tab's choice. */ }
  }
  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function ThemeToggle() {
  const settings = useContext(ThemeContext);
  if (!settings) return null;
  const dark = settings.theme === 'dark';
  const label = dark ? '라이트 모드로 전환' : '다크 모드로 전환';
  return <button type="button" className="quiet icon-button theme-toggle" aria-label={label} title={label} onClick={settings.toggle}>
    <Icon name={dark ? 'sun' : 'moon'} />
  </button>;
}
