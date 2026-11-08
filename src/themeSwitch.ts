import { THEME_KEY, parseTheme, toggleTheme, type Theme } from './core/theme';

/**
 * Conecta el interruptor sol/luna. El tema inicial ya lo pone un script en
 * index.html antes de pintar (así no hay un destello claro al cargar).
 */
export function setupThemeSwitch(button: HTMLButtonElement): void {
  const root = document.documentElement;

  const apply = (theme: Theme) => {
    root.dataset.theme = theme;
    const dark = theme === 'dark';
    button.setAttribute('aria-checked', String(dark));
    button.title = dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
  };

  apply(parseTheme(root.dataset.theme));

  button.addEventListener('click', () => {
    const next = toggleTheme(parseTheme(root.dataset.theme));
    apply(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Sin almacenamiento (modo privado): el cambio vale para esta visita.
    }
  });
}
