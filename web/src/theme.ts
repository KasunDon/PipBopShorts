export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'backlot-theme';

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private-mode / storage-disabled: the theme still applies for this session.
  }
}
