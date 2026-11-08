import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import { buildTextRuns, type PdfTextItem, type Rect, type TextOverlay, type TextRun } from './overlays';

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

/**
 * Dibuja una página en un canvas con el ancho indicado (en px CSS).
 * Devuelve el viewport en px CSS (el canvas tiene además en cuenta la densidad de pantalla).
 */
export async function renderThumbnail(
  doc: PDFDocumentProxy,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  width = 180,
): Promise<PageViewport> {
  // El tamaño en pantalla de la miniatura lo decide el CSS.
  const { viewport, task } = await startRender(doc, pageIndex, canvas, width, 0, false);
  await task.promise;
  return viewport;
}

/**
 * Empieza a dibujar una página. `rotation` es la rotación total con la que se
 * ve (la propia del PDF + la que haya añadido el usuario); por defecto, la del PDF.
 */
export async function startRender(
  doc: PDFDocumentProxy,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  width: number,
  extraRotation = 0,
  setCssSize = true,
): Promise<{ viewport: PageViewport; task: RenderTask }> {
  const page = await doc.getPage(pageIndex + 1);
  const rotation = (page.rotate + extraRotation) % 360;
  const base = page.getViewport({ scale: 1, rotation });
  const viewport = page.getViewport({ scale: width / base.width, rotation });
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  if (setCssSize) {
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
  }

  const task = page.render({ canvas, viewport: viewport.clone({ scale: viewport.scale * dpr }) });
  return { viewport, task };
}

/** Trozos de texto de la página, con una pista de la fuente de cada uno. */
export async function getTextRuns(
  doc: PDFDocumentProxy,
  pageIndex: number,
): Promise<{ runs: TextRun[]; fontHint: (fontName: string) => string }> {
  const page = await doc.getPage(pageIndex + 1);
  const content = await page.getTextContent();
  const items = content.items.filter((i): i is PdfTextItem & typeof i => 'str' in i);
  const fontHint = (fontName: string) => {
    let name = '';
    try {
      // Tras dibujar la página, pdf.js conoce el nombre real de la fuente (p. ej. "Arial-BoldMT").
      if (page.commonObjs.has(fontName)) name = String(page.commonObjs.get(fontName)?.name ?? '');
    } catch {
      /* no pasa nada: usamos solo la familia */
    }
    return `${name} ${content.styles[fontName]?.fontFamily ?? ''}`;
  };
  return { runs: buildTextRuns(items), fontHint };
}

// ---------- Conversión de coordenadas ----------

export function pdfToView(viewport: PageViewport, x: number, y: number): [number, number] {
  const [vx, vy] = viewport.convertToViewportPoint(x, y);
  return [vx, vy];
}

export function viewToPdf(viewport: PageViewport, x: number, y: number): [number, number] {
  const [px, py] = viewport.convertToPdfPoint(x, y);
  return [px, py];
}

/** Rectángulo del PDF -> rectángulo en pantalla (siempre con w/h positivos). */
export function rectToView(viewport: PageViewport, r: Rect): Rect {
  const [x1, y1] = pdfToView(viewport, r.x, r.y);
  const [x2, y2] = pdfToView(viewport, r.x + r.w, r.y + r.h);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

export function rectToPdf(viewport: PageViewport, r: Rect): Rect {
  const [x1, y1] = viewToPdf(viewport, r.x, r.y);
  const [x2, y2] = viewToPdf(viewport, r.x + r.w, r.y + r.h);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/** Giro (en grados, sentido horario como CSS) con el que se ve un texto en pantalla. */
export function screenAngle(viewport: PageViewport, overlay: TextOverlay): number {
  return (((viewport.rotation - overlay.angle) % 360) + 360) % 360;
}

export const CSS_FONTS = {
  helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  times: '"Times New Roman", Times, "Liberation Serif", serif',
} as const;

/** Pinta los textos añadidos encima de una miniatura ya dibujada. */
export function paintOverlays(canvas: HTMLCanvasElement, viewport: PageViewport, overlays: TextOverlay[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const k = canvas.width / viewport.width;
  for (const o of overlays) {
    if (o.cover) {
      const r = rectToView(viewport, o.cover);
      ctx.fillStyle = o.cover.color;
      ctx.fillRect(r.x * k, r.y * k, r.w * k, r.h * k);
    }
    if (!o.text.trim()) continue;
    const [x, y] = pdfToView(viewport, o.x, o.y);
    ctx.save();
    ctx.translate(x * k, y * k);
    ctx.rotate((screenAngle(viewport, o) * Math.PI) / 180);
    ctx.font = `${o.bold ? 'bold ' : ''}${o.size * viewport.scale * k}px ${CSS_FONTS[o.font]}`;
    ctx.fillStyle = o.color;
    ctx.fillText(o.text, 0, 0);
    ctx.restore();
  }
}

/** Lee los píxeles de una zona (en px CSS del viewport) del canvas: borde exterior e interior. */
export function samplePixels(
  canvas: HTMLCanvasElement,
  viewport: PageViewport,
  zone: Rect,
): { border: [number, number, number][]; inside: [number, number, number][] } {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const border: [number, number, number][] = [];
  const inside: [number, number, number][] = [];
  if (!ctx) return { border, inside };
  const k = canvas.width / viewport.width;
  const pad = Math.max(2, Math.round(2 * k));
  const x0 = Math.max(0, Math.floor(zone.x * k) - pad);
  const y0 = Math.max(0, Math.floor(zone.y * k) - pad);
  const x1 = Math.min(canvas.width, Math.ceil((zone.x + zone.w) * k) + pad);
  const y1 = Math.min(canvas.height, Math.ceil((zone.y + zone.h) * k) + pad);
  if (x1 <= x0 || y1 <= y0) return { border, inside };
  const { data } = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  const w = x1 - x0;
  for (let j = 0; j < y1 - y0; j++) {
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 4;
      const px: [number, number, number] =
        data[o + 3] === 0 ? [255, 255, 255] : [data[o], data[o + 1], data[o + 2]];
      const edge = i < pad || j < pad || i >= w - pad || j >= y1 - y0 - pad;
      (edge ? border : inside).push(px);
    }
  }
  return { border, inside };
}
