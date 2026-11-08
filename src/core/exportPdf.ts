import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont } from 'pdf-lib';
import type { PageRef } from './pages';
import { cleanText, hexToRgb, type TextOverlay } from './overlays';

const toColor = (hex: string) => {
  const [r, g, b] = hexToRgb(hex);
  return rgb(r / 255, g / 255, b / 255);
};

/**
 * Genera un PDF nuevo a partir del original y la lista de páginas.
 * El original nunca se modifica.
 */
export async function buildPdf(sourceBytes: Uint8Array, pages: PageRef[]): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error('El documento no tiene páginas.');

  const source = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
  const output = await PDFDocument.create();

  const copied = await output.copyPages(
    source,
    pages.map((p) => p.sourceIndex),
  );

  // Las fuentes se incrustan solo si hacen falta (y una sola vez).
  const fonts = new Map<string, Promise<PDFFont>>();
  const fontFor = (o: TextOverlay) => {
    const name =
      o.font === 'times'
        ? o.bold ? StandardFonts.TimesRomanBold : StandardFonts.TimesRoman
        : o.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica;
    if (!fonts.has(name)) fonts.set(name, output.embedFont(name));
    return fonts.get(name)!;
  };

  for (const [i, page] of copied.entries()) {
    const ref = pages[i];
    if (ref.rotation) {
      const current = page.getRotation().angle;
      page.setRotation(degrees((current + ref.rotation) % 360));
    }
    output.addPage(page);

    // pdf-lib envuelve el contenido original en q/Q antes de dibujar, así que
    // nuestras coordenadas no se ven afectadas por transformaciones del PDF.
    for (const o of ref.overlays ?? []) {
      if (o.cover) {
        page.drawRectangle({
          x: o.cover.x,
          y: o.cover.y,
          width: o.cover.w,
          height: o.cover.h,
          color: toColor(o.cover.color),
        });
      }
      const text = cleanText(o.text).text;
      if (text.trim()) {
        page.drawText(text, {
          x: o.x,
          y: o.y,
          size: o.size,
          font: await fontFor(o),
          color: toColor(o.color),
          rotate: degrees(o.angle),
        });
      }
    }
  }

  return output.save();
}

export function downloadBytes(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "contrato.pdf" -> "contrato (editado).pdf" */
export function outputName(original: string, suffix = 'editado'): string {
  const base = original.replace(/\.pdf$/i, '') || 'documento';
  return `${base} (${suffix}).pdf`;
}
