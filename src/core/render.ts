import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface OpenedPdf {
  doc: PDFDocumentProxy;
  /** Libera el worker y la memoria del documento. */
  close: () => Promise<void>;
}

export async function openPdf(bytes: Uint8Array): Promise<OpenedPdf> {
  // pdf.js se queda con el buffer, así que le pasamos una copia.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  return { doc, close: () => task.destroy() };
}

/** Dibuja una página en un canvas con el ancho indicado (en px CSS). */
export async function renderThumbnail(
  doc: PDFDocumentProxy,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  width = 180,
): Promise<void> {
  const page = await doc.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: (width / base.width) * dpr });

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  await page.render({ canvas, viewport }).promise;
}
