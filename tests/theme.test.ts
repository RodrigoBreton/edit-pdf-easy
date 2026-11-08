import { describe, expect, it } from 'vitest';
import { parseTheme, toggleTheme } from '../src/core/theme';

describe('tema', () => {
  it('es oscuro por defecto', () => {
    expect(parseTheme(null)).toBe('dark');
    expect(parseTheme(undefined)).toBe('dark');
    expect(parseTheme('cualquier-cosa')).toBe('dark');
  });

  it('respeta el claro si se guardó', () => {
    expect(parseTheme('light')).toBe('light');
  });

  it('alterna entre oscuro y claro', () => {
    expect(toggleTheme('dark')).toBe('light');
    expect(toggleTheme('light')).toBe('dark');
  });
});
