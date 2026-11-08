import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees, pushGraphicsState, concatTransformationMatrix } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  buildTextRuns,
  cleanText,
  coverForText,
  dominantColor,
  guessFont,
  inkColor,
  localRectToPdf,
  runAt,
  snapAngle,
  suggestFontSize,
  type TextOverlay,
} from '../src/core/overlays';
import { createPages, setOverlays } from '../src/core/pages';
import { buildPdf } from '../src/core/exportPdf';

const overlay = (extra: Partial<TextOverlay> = {}): TextOverlay => ({
  id: 'o1',
  x: 50,
  y: 100,
  angle: 0,
  text: '15/06/2026',
  size: 12,
  font: 'helvetica',
  bold: false,
  color: '#000000',
  cover: null,
  ...extra,
});

/** Lee los textos de la primera página con pdf.js, como haría el navegador. */
async function readText(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const items = content.items.filter((i) => 'str' in i && i.str.trim()) as {
    str: string;
    transform: number[];
  }[];
  await task.destroy();
  return items.map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], b: i.transform[1] }));
}

describe('geometría de overlays', () => {
  it('normaliza ángulos', () => {
    expect(snapAngle(-90)).toBe(270);
    expect(snapAngle(89.6)).toBe(90);
    expect(snapAngle(360)).toBe(0);
  });

  it('convierte rectángulos girados al espacio del PDF', () => {
    expect(localRectToPdf(100, 100, 0, 0, -2, 50, 10)).toEqual({ x: 100, y: 98, w: 50, h: 10 });
    // Texto que sube (90º): avanzar por la línea es subir; "debajo" de la base queda a la derecha.
    expect(localRectToPdf(100, 100, 90, 0, -2, 50, 10)).toEqual({ x: 92, y: 100, w: 10, h: 50 });
  });

  it('tapa algo por debajo de la línea base', () => {
    const r = coverForText(10, 100, 0, 40, 10);
    expect(r.y).toBeLessThan(100 - 2);
    expect(r.y + r.h).toBeGreaterThan(100 + 9);
    expect(r.w).toBeGreaterThan(40);
  });

  it('propone tamaño de letra según la altura', () => {
    expect(suggestFontSize(18)).toBe(12);
    expect(suggestFontSize(1)).toBe(6);
  });
});

describe('trozos de texto clicables', () => {
  const item = (str: string, x: number, width: number, y = 700) => ({
    str,
    transform: [12, 0, 0, 12, x, y],
    width,
    fontName: 'f1',
  });

  it('une letras sueltas pegadas y separa palabras', () => {
    const runs = buildTextRuns([
      item('1', 100, 6),
      item('2', 106, 6),
      item('/03', 112, 18),
      item('Madrid', 140, 36), // hay un hueco de 10pt: palabra distinta
      item('Otra línea', 100, 50, 680),
    ]);
    expect(runs.map((r) => r.str)).toEqual(['12/03', 'Madrid', 'Otra línea']);
    expect(runs[0].width).toBeCloseTo(30);
  });

  it('encuentra el texto bajo el clic', () => {
    const runs = buildTextRuns([item('Fecha', 100, 30), item('12/03/2024', 140, 60)]);
    expect(runAt(runs, 150, 704)?.str).toBe('12/03/2024');
    expect(runAt(runs, 300, 704)).toBeUndefined();
  });

  it('adivina la fuente', () => {
    expect(guessFont('ABCDEF+TimesNewRomanPS-BoldMT')).toEqual({ font: 'times', bold: true });
    expect(guessFont('ArialMT')).toEqual({ font: 'helvetica', bold: false });
    expect(guessFont('sans-serif')).toEqual({ font: 'helvetica', bold: false });
    expect(guessFont('serif')).toEqual({ font: 'times', bold: false });
  });
});

describe('caracteres y colores', () => {
  it('acepta tildes, ñ y € pero no emojis ni saltos de línea', () => {
    expect(cleanText('Año 2026: 1.250,50 € — «ok»')).toEqual({ text: 'Año 2026: 1.250,50 € — «ok»', removed: [] });
    expect(cleanText('hola\n😀 mundo')).toEqual({ text: 'hola  mundo', removed: ['😀'] });
  });

  it('adivina fondo y color de letra', () => {
    const white: [number, number, number] = [255, 255, 255];
    const px = [white, white, white, [250, 251, 252] as [number, number, number], [20, 30, 160] as [number, number, number]];
    expect(dominantColor(px)).toBe('#ffffff');
    expect(dominantColor([[200, 220, 240], [201, 221, 241]])).toBe('#c9ddf1');
    expect(inkColor(px, '#ffffff')).toBe('#141ea0');
    expect(inkColor([[40, 40, 40]], '#ffffff')).toBe('#000000');
    expect(inkColor([white], '#ffffff')).toBe('#000000');
  });
});

describe('exportar con overlays', () => {
  it('dibuja el texto donde se indica y en la página correcta', async () => {
    const src = await PDFDocument.create();
    src.addPage([300, 400]);
    src.addPage([300, 400]);
    let pages = createPages(2);
    pages = setOverlays(pages, pages[0].id, [
      overlay({ cover: { x: 45, y: 95, w: 80, h: 16, color: '#ffffff' } }),
    ]);
    pages = [pages[1], pages[0]]; // la editada pasa a ser la segunda

    const out = await buildPdf(await src.save(), pages);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);

    const onlySecond = await PDFDocument.create();
    const [p] = await onlySecond.copyPages(doc, [1]);
    onlySecond.addPage(p);
    const text = await readText(await onlySecond.save());
    expect(text).toHaveLength(1);
    expect(text[0].str).toBe('15/06/2026');
    expect(text[0].x).toBeCloseTo(50);
    expect(text[0].y).toBeCloseTo(100);

    expect(await readText(await (async () => {
      const first = await PDFDocument.create();
      const [q] = await first.copyPages(doc, [0]);
      first.addPage(q);
      return first.save();
    })())).toHaveLength(0);
  });

  it('no se descoloca si el PDF original deja una transformación aplicada', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([300, 400]);
    // Contenido "mal educado": escala x2 y no restaura el estado gráfico.
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(2, 0, 0, 2, 0, 0));
    page.drawText('original', { x: 10, y: 10, size: 8, font: await src.embedFont(StandardFonts.Helvetica) });

    let pages = createPages(1);
    pages = setOverlays(pages, pages[0].id, [overlay()]);
    const text = await readText(await buildPdf(await src.save(), pages));
    const ours = text.find((t) => t.str === '15/06/2026')!;
    expect(ours.x).toBeCloseTo(50);
    expect(ours.y).toBeCloseTo(100);
  });

  it('gira el texto y quita caracteres no soportados sin fallar', async () => {
    const src = await PDFDocument.create();
    src.addPage([300, 400]).setRotation(degrees(90));
    let pages = createPages(1);
    pages = setOverlays(pages, pages[0].id, [overlay({ angle: 90, text: 'Hola 😀', bold: true, font: 'times' })]);
    const text = await readText(await buildPdf(await src.save(), pages));
    expect(text[0].str.trim()).toBe('Hola');
    expect(text[0].b).toBeGreaterThan(0); // la línea base sube: está girado 90º
  });
});
