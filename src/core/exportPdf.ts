import { PDFDocument, degrees } from 'pdf-lib';
import type { PageRef } from './pages';

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

  copied.forEach((page, i) => {
    const extra = pages[i].rotation;
    if (extra) {
      const current = page.getRotation().angle;
      page.setRotation(degrees((current + extra) % 360));
    }
    output.addPage(page);
  });

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
