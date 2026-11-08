/**
 * Textos añadidos encima de una página ("tapar y escribir encima").
 *
 * Todas las coordenadas están en el espacio del PDF original (puntos, origen
 * abajo a la izquierda, sin rotación de página), igual que las usa pdf-lib.
 * Así el resultado no depende del zoom de la pantalla ni de cómo se gire la
 * página después.
 */
export type FontName = 'helvetica' | 'times';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextOverlay {
  id: string;
  /** Inicio de la línea base del texto. */
  x: number;
  y: number;
  /** Ángulo del texto en grados (antihorario, múltiplo de 90). */
  angle: number;
  text: string;
  size: number;
  font: FontName;
  bold: boolean;
  /** Color del texto en hex (#rrggbb). */
  color: string;
  /** Parche que tapa lo que había debajo (null = texto sin fondo). */
  cover: (Rect & { color: string }) | null;
}

let counter = 0;
export const newOverlayId = () => `o${Date.now().toString(36)}${++counter}`;

// ---------- Geometría ----------

/** Normaliza un ángulo a 0, 90, 180 o 270. */
export function snapAngle(deg: number): number {
  return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
}

/**
 * Convierte un rectángulo expresado "a lo largo del texto" (lx avanza por la
 * línea base, ly hacia arriba) al rectángulo equivalente en el espacio del PDF.
 */
export function localRectToPdf(
  originX: number,
  originY: number,
  angle: number,
  lx: number,
  ly: number,
  lw: number,
  lh: number,
): Rect {
  const rad = (angle * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad) * 1e6) / 1e6;
  const sin = Math.round(Math.sin(rad) * 1e6) / 1e6;
  const corners = [
    [lx, ly],
    [lx + lw, ly],
    [lx, ly + lh],
    [lx + lw, ly + lh],
  ].map(([u, v]) => [originX + u * cos - v * sin, originY + u * sin + v * cos]);
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Rectángulo que tapa un texto: un poco por debajo de la base y por encima de las tildes. */
export function coverForText(x: number, y: number, angle: number, width: number, size: number): Rect {
  return localRectToPdf(x, y, angle, -0.08 * size, -0.24 * size, width + 0.16 * size, 1.16 * size);
}

/** Tamaño de letra razonable para escribir dentro de una zona de cierta altura (en puntos). */
export function suggestFontSize(zoneHeight: number): number {
  return Math.min(72, Math.max(6, Math.round(zoneHeight * 0.68)));
}

// ---------- Texto del PDF (pdf.js) ----------

/** Lo mínimo que necesitamos de un `TextItem` de pdf.js. */
export interface PdfTextItem {
  str: string;
  /** Matriz [a, b, c, d, e, f] en espacio del PDF. */
  transform: number[];
  /** Ancho a lo largo de la línea base, en puntos. */
  width: number;
  fontName: string;
}

/** Un trozo de texto clicable: uno o varios TextItem pegados en la misma línea. */
export interface TextRun {
  str: string;
  x: number;
  y: number;
  angle: number;
  size: number;
  width: number;
  fontName: string;
  /** Zona que ocupa en el PDF (sirve para el clic y para taparlo). */
  box: Rect;
}

function itemToRun(item: PdfTextItem): TextRun | null {
  const [a, b, c, d, e, f] = item.transform;
  const size = Math.hypot(c, d) || Math.hypot(a, b);
  if (!item.str.trim() || !size) return null;
  const angle = snapAngle((Math.atan2(b, a) * 180) / Math.PI);
  return {
    str: item.str,
    x: e,
    y: f,
    angle,
    size,
    width: item.width,
    fontName: item.fontName,
    box: coverForText(e, f, angle, item.width, size),
  };
}

/** Distancia a lo largo de la línea base entre el final de `a` y el inicio de `b` (y desvío vertical). */
function along(a: TextRun, b: TextRun): { gap: number; drift: number } {
  const rad = (a.angle * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const u = dx * cos + dy * sin;
  const v = -dx * sin + dy * cos;
  return { gap: u - a.width, drift: v };
}

/**
 * Agrupa los trozos que van pegados (algunos PDFs dibujan "12/03/2024" letra a
 * letra). No une palabras separadas por un espacio normal.
 */
export function buildTextRuns(items: PdfTextItem[]): TextRun[] {
  const runs: TextRun[] = [];
  for (const item of items) {
    const run = itemToRun(item);
    if (!run) continue;
    const prev = runs[runs.length - 1];
    if (prev && prev.angle === run.angle && Math.abs(prev.size - run.size) < prev.size * 0.15) {
      const { gap, drift } = along(prev, run);
      if (Math.abs(drift) < prev.size * 0.1 && gap > -prev.size * 0.1 && gap < prev.size * 0.12) {
        prev.str += run.str;
        prev.width += gap + run.width;
        prev.box = coverForText(prev.x, prev.y, prev.angle, prev.width, prev.size);
        continue;
      }
    }
    runs.push(run);
  }
  return runs;
}

export function runAt(runs: TextRun[], px: number, py: number): TextRun | undefined {
  // Si hay solapes, el más pequeño suele ser el que el usuario quiere.
  return runs
    .filter((r) => px >= r.box.x && px <= r.box.x + r.box.w && py >= r.box.y && py <= r.box.y + r.box.h)
    .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0];
}

/** Intenta adivinar si la fuente original es tipo Times y si es negrita. */
export function guessFont(fontNameOrFamily: string): { font: FontName; bold: boolean } {
  const n = fontNameOrFamily;
  const font: FontName = !/sans/i.test(n) && /times|serif|roman|georgia|garamond|cambria/i.test(n)
    ? 'times'
    : 'helvetica';
  return { font, bold: /bold|black|heavy|semibold|demi/i.test(n) };
}

// ---------- Caracteres soportados ----------

/**
 * Las fuentes estándar de pdf-lib usan la codificación WinAnsi: letras latinas,
 * tildes, ñ, €, comillas tipográficas... pero no, por ejemplo, emojis o griego.
 */
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

export function isSupportedChar(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch);
}

/** Limpia el texto escrito: una sola línea y sin caracteres que el PDF no puede guardar. */
export function cleanText(text: string): { text: string; removed: string[] } {
  const removed = new Set<string>();
  let out = '';
  for (const ch of text.replace(/[\r\n\t]+/g, ' ')) {
    if (isSupportedChar(ch)) out += ch;
    else removed.add(ch);
  }
  return { text: out, removed: [...removed] };
}

// ---------- Colores ----------

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

/** Color más repetido (agrupando tonos parecidos). Sirve para adivinar el fondo. */
export function dominantColor(pixels: [number, number, number][], fallback = '#ffffff'): string {
  if (!pixels.length) return fallback;
  const buckets = new Map<string, { n: number; sum: [number, number, number] }>();
  for (const [r, g, b] of pixels) {
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const bucket = buckets.get(key) ?? { n: 0, sum: [0, 0, 0] };
    bucket.n++;
    bucket.sum[0] += r;
    bucket.sum[1] += g;
    bucket.sum[2] += b;
    buckets.set(key, bucket);
  }
  const best = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
  const [r, g, b] = best.sum.map((s) => s / best.n);
  // Casi blanco -> blanco puro (evita parches grisáceos por el antialiasing).
  if (r > 245 && g > 245 && b > 245) return '#ffffff';
  return rgbToHex(r, g, b);
}

/** El píxel más distinto del fondo: suele ser el color de la letra. */
export function inkColor(pixels: [number, number, number][], background: string): string {
  const bg = hexToRgb(background);
  let best: [number, number, number] | null = null;
  let bestDist = 0;
  for (const p of pixels) {
    const dist = Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]);
    if (dist > bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  if (!best || bestDist < 80) return '#000000';
  // Grises oscuros -> negro, que es lo habitual.
  const [r, g, b] = best;
  if (Math.max(r, g, b) < 90 && Math.max(r, g, b) - Math.min(r, g, b) < 30) return '#000000';
  return rgbToHex(r, g, b);
}
