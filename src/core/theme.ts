export type Theme = 'dark' | 'light';

export const THEME_KEY = 'pdf-facil-theme';

/** Oscuro por defecto: solo es claro si la persona lo eligió antes. */
export function parseTheme(saved: string | null | undefined): Theme {
  return saved === 'light' ? 'light' : 'dark';
}

export function toggleTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}
