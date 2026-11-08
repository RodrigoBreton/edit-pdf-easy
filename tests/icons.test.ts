import { describe, expect, it } from 'vitest';
import { icon, isIconName } from '../src/icons';

describe('icon', () => {
  it('genera un SVG decorativo de un solo trazo', () => {
    const svg = icon('trash');
    expect(svg).toMatch(/^<svg class="ico"/);
    expect(svg).toContain('aria-hidden="true"');
    expect(svg.match(/<path/g)).toHaveLength(1);
  });

  it('reconoce solo nombres que existen', () => {
    expect(isIconName('rotate')).toBe(true);
    expect(isIconName('toString')).toBe(false);
    expect(isIconName('nada')).toBe(false);
  });
});
