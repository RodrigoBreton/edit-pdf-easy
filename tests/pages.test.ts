import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { History, createPages, movePage, pickPages, removePages, rotatePages } from '../src/core/pages';
import { buildPdf, outputName } from '../src/core/exportPdf';

async function samplePdf(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Cada página con un ancho distinto para poder identificarla después.
  for (let i = 0; i < n; i++) doc.addPage([100 + i * 10, 200]);
  return doc.save();
}

describe('modelo de páginas', () => {
  it('reordena', () => {
    const pages = createPages(4);
    const moved = movePage(pages, 0, 2);
    expect(moved.map((p) => p.sourceIndex)).toEqual([1, 2, 0, 3]);
    expect(pages.map((p) => p.sourceIndex)).toEqual([0, 1, 2, 3]); // no muta
  });

  it('ignora movimientos fuera de rango', () => {
    const pages = createPages(2);
    expect(movePage(pages, 0, 5)).toBe(pages);
  });

  it('quita, gira y selecciona', () => {
    const pages = createPages(3);
    const ids = new Set([pages[1].id]);
    expect(removePages(pages, ids).map((p) => p.sourceIndex)).toEqual([0, 2]);
    expect(rotatePages(pages, ids)[1].rotation).toBe(90);
    expect(rotatePages(rotatePages(rotatePages(rotatePages(pages, ids), ids), ids), ids)[1].rotation).toBe(0);
    expect(pickPages(pages, ids)).toHaveLength(1);
  });

  it('deshace', () => {
    const h = new History<number>(2);
    h.push(1);
    h.push(2);
    h.push(3);
    expect(h.pop()).toBe(3);
    expect(h.pop()).toBe(2);
    expect(h.canUndo).toBe(false);
  });
});

describe('exportar PDF', () => {
  it('aplica orden, borrado y rotación', async () => {
    const src = await samplePdf(4);
    let pages = createPages(4);
    pages = movePage(pages, 3, 0); // 3,0,1,2
    pages = removePages(pages, new Set([pages[2].id])); // 3,0,2
    pages = rotatePages(pages, new Set([pages[1].id])); // la página 0 girada

    const out = await PDFDocument.load(await buildPdf(src, pages));
    const result = out.getPages();
    expect(result.map((p) => p.getWidth())).toEqual([130, 100, 120]);
    expect(result.map((p) => p.getRotation().angle)).toEqual([0, 90, 0]);
  });

  it('no permite un PDF vacío', async () => {
    await expect(buildPdf(await samplePdf(1), [])).rejects.toThrow();
  });

  it('nombra la copia sin pisar el original', () => {
    expect(outputName('contrato.PDF')).toBe('contrato (editado).pdf');
  });
});
