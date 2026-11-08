/**
 * Vista ampliada de una página para cambiar o añadir texto.
 *
 * - "Cambiar texto": clic sobre un texto del PDF -> se tapa y aparece una caja
 *   con el texto original para editarlo.
 * - "Añadir texto": clic en cualquier sitio -> caja de texto sin fondo.
 * - "Tapar zona": arrastrar un rectángulo -> se tapa con el color de fondo y se
 *   puede escribir encima (útil en PDFs escaneados, que no tienen texto).
 *
 * Mientras se escribe, el texto es un "borrador" (draft). Al terminar (Intro,
 * clic fuera, botón Hecho, cambiar de página...) se guarda con un único
 * `commit`, así "Deshacer" lo deshace de una vez.
 */
import { icon } from '../icons';
import type { PDFDocumentProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import type { PageRef } from '../core/pages';
import { setOverlays } from '../core/pages';
import {
  cleanText,
  dominantColor,
  guessFont,
  inkColor,
  newOverlayId,
  runAt,
  suggestFontSize,
  type Rect,
  type TextOverlay,
  type TextRun,
} from '../core/overlays';
import {
  CSS_FONTS,
  getTextRuns,
  pdfToView,
  rectToPdf,
  rectToView,
  samplePixels,
  screenAngle,
  startRender,
  viewToPdf,
} from '../core/render';

type Mode = 'replace' | 'add' | 'cover';

export interface EditorHost {
  getDoc(): PDFDocumentProxy | null;
  getPages(): PageRef[];
  commit(pages: PageRef[]): void;
  toast(message: string, kind?: 'info' | 'error'): void;
  /** Se llama al abrir/cerrar, para que la app muestre u oculte las miniaturas. */
  onToggle(open: boolean): void;
}

interface Draft {
  overlay: TextOverlay;
  /** true si aún no existe en la página (es nuevo). */
  isNew: boolean;
  /** Copia de cómo estaba al empezar, para saber si ha cambiado y poder cancelar. */
  original: string;
}

const HINTS: Record<Mode, string> = {
  replace: 'Haz clic sobre el texto que quieras cambiar.',
  add: 'Haz clic donde quieras escribir.',
  cover: 'Arrastra para marcar la zona que quieres tapar. Luego puedes escribir encima.',
};
const NO_TEXT_HINT =
  'Esta página no tiene texto que se pueda seleccionar (puede ser un escaneo). Usa «Tapar zona».';

const COLORS = [
  { hex: '#000000', name: 'Negro' },
  { hex: '#1d3a8a', name: 'Azul' },
  { hex: '#b91c1c', name: 'Rojo' },
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function createPageEditor(host: EditorHost) {
  const root = $('page-editor');
  const head = $('pe-head');
  const title = $('pe-title');
  const hint = $('pe-hint');
  const stage = $('pe-stage');
  const pageBox = $('pe-page');
  const canvas = $<HTMLCanvasElement>('pe-canvas');
  const layer = $('pe-layer');
  const props = $('pe-props');
  const btnBack = $<HTMLButtonElement>('pe-back');
  const btnPrev = $<HTMLButtonElement>('pe-prev');
  const btnNext = $<HTMLButtonElement>('pe-next');
  const toolButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-mode]')];

  const hover = document.createElement('div');
  hover.className = 'pe-hover';
  hover.hidden = true;
  const marquee = document.createElement('div');
  marquee.className = 'pe-marquee';
  marquee.hidden = true;

  let pageId: string | null = null;
  let mode: Mode = 'replace';
  let viewport: PageViewport | null = null;
  let renderedKey = -1;
  let renderTask: RenderTask | null = null;
  let renderToken = 0;
  let runs: TextRun[] = [];
  let fontHint: (fontName: string) => string = () => '';
  let draft: Draft | null = null;
  /** Tamaño usado la última vez en "Añadir texto". */
  let lastAddSize = 0;

  // ---------- Utilidades ----------
  const currentPage = () => host.getPages().find((p) => p.id === pageId) ?? null;
  const pageIndex = () => host.getPages().findIndex((p) => p.id === pageId);

  function layerPoint(e: PointerEvent | MouseEvent): [number, number] {
    const r = layer.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function setHint() {
    hint.textContent = mode === 'replace' && viewport && runs.length === 0 ? NO_TEXT_HINT : HINTS[mode];
  }

  function setMode(next: Mode) {
    finishDraft();
    mode = next;
    toolButtons.forEach((b) => {
      const on = b.dataset.mode === next;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    layer.dataset.mode = next;
    hover.hidden = true;
    setHint();
  }

  // ---------- Abrir / cerrar / pintar la página ----------
  async function open(id: string) {
    finishDraft();
    pageId = id;
    root.hidden = false;
    host.onToggle(true);
    // La barra de herramientas queda pegada debajo de la barra principal.
    const bar = document.querySelector<HTMLElement>('.toolbar');
    head.style.top = `${bar?.offsetHeight ?? 0}px`;
    renderedKey = -1;
    await refresh();
    window.scrollTo({ top: 0 });
  }

  function close() {
    if (!pageId) return;
    finishDraft();
    renderTask?.cancel();
    pageId = null;
    viewport = null;
    root.hidden = true;
    layer.replaceChildren();
    host.onToggle(false);
  }

  /** Vuelve a pintar tras un cambio (deshacer, girar...). */
  async function refresh() {
    if (!pageId) return;
    const page = currentPage();
    const doc = host.getDoc();
    if (!page || !doc) {
      close();
      return;
    }
    const i = pageIndex();
    const total = host.getPages().length;
    title.textContent = `Página ${i + 1} de ${total}`;
    btnPrev.disabled = i <= 0;
    btnNext.disabled = i >= total - 1;

    // Solo se vuelve a dibujar si cambia la página o su giro.
    const key = page.sourceIndex * 1000 + page.rotation;
    if (key !== renderedKey) {
      renderedKey = key;
      const token = ++renderToken;
      renderTask?.cancel();
      viewport = null;
      runs = [];
      layer.replaceChildren();
      setHint();
      // Ancho de la zona disponible, con un máximo para que no quede enorme.
      const width = Math.max(280, Math.min(stage.clientWidth - 2, 1000));
      const started = await startRender(doc, page.sourceIndex, canvas, width, page.rotation);
      if (token !== renderToken) {
        started.task.cancel();
        return;
      }
      renderTask = started.task;
      try {
        await started.task.promise;
      } catch (err) {
        if ((err as Error)?.name === 'RenderingCancelledException') return;
        throw err;
      }
      if (token !== renderToken) return;
      viewport = started.viewport;
      layer.style.width = `${viewport.width}px`;
      layer.style.height = `${viewport.height}px`;
      const text = await getTextRuns(doc, page.sourceIndex);
      if (token !== renderToken) return;
      runs = text.runs;
      fontHint = text.fontHint;
      setHint();
    }
    renderOverlays();
  }

  // ---------- Overlays en pantalla ----------
  function renderOverlays() {
    const page = currentPage();
    if (!page || !viewport) return;
    layer.replaceChildren(hover, marquee);
    const list = [...page.overlays];
    if (draft) {
      const at = list.findIndex((o) => o.id === draft!.overlay.id);
      if (at >= 0) list[at] = draft.overlay;
      else list.push(draft.overlay);
    }
    for (const o of list) layer.appendChild(overlayElement(o, draft?.overlay.id === o.id));
    renderProps();
  }

  function overlayElement(o: TextOverlay, editing: boolean): HTMLElement {
    const vp = viewport!;
    const wrap = document.createElement('div');
    wrap.className = 'ov' + (editing ? ' editing' : '');
    wrap.dataset.id = o.id;

    if (o.cover) {
      const r = rectToView(vp, o.cover);
      const cover = document.createElement('div');
      cover.className = 'ov-cover';
      Object.assign(cover.style, {
        left: `${r.x}px`,
        top: `${r.y}px`,
        width: `${r.w}px`,
        height: `${r.h}px`,
        background: o.cover.color,
      });
      wrap.appendChild(cover);
    }

    const [ax, ay] = pdfToView(vp, o.x, o.y);
    const anchor = document.createElement('div');
    anchor.className = 'ov-anchor';
    anchor.style.left = `${ax}px`;
    anchor.style.top = `${ay}px`;
    anchor.style.transform = `rotate(${screenAngle(vp, o)}deg)`;

    const box = document.createElement('div');
    box.className = 'ov-box';
    Object.assign(box.style, {
      fontFamily: CSS_FONTS[o.font],
      fontWeight: o.bold ? '700' : '400',
      fontSize: `${o.size * vp.scale}px`,
      color: o.color,
    });
    const text = document.createElement('span');
    text.className = 'ov-text';
    text.textContent = o.text;
    // Marca invisible en la línea base: nos dice cuánto subir la caja para que
    // la base del texto quede exactamente donde estará en el PDF.
    const base = document.createElement('span');
    base.className = 'ov-base';
    box.append(text, base);
    anchor.appendChild(box);
    wrap.appendChild(anchor);

    if (editing) {
      text.contentEditable = 'plaintext-only';
      text.spellcheck = false;
      text.setAttribute('role', 'textbox');
      text.setAttribute('aria-label', 'Texto');
      text.dataset.placeholder = 'Escribe aquí';
      text.addEventListener('keydown', onTextKeydown);
      text.addEventListener('input', () => {
        if (draft) draft.overlay.text = text.textContent ?? '';
      });
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'ov-handle';
      handle.title = 'Arrastra para mover';
      handle.setAttribute('aria-label', 'Mover');
      handle.innerHTML = icon('move');
      handle.addEventListener('pointerdown', (e) => startMove(e, wrap));
      box.appendChild(handle);
    }

    // Ajustar la línea base cuando ya está en el DOM.
    requestAnimationFrame(() => {
      box.style.transform = `translateY(${-base.offsetTop}px)`;
      if (editing) placeProps(wrap);
    });
    return wrap;
  }

  function focusDraft(clientX?: number, clientY?: number) {
    const el = layer.querySelector<HTMLElement>('.ov.editing .ov-text');
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel) return;
    let range: Range | null = null;
    // Si se ha hecho clic sobre el texto, poner el cursor justo ahí.
    if (clientX != null && clientY != null) {
      const doc = document as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      };
      const pos = doc.caretPositionFromPoint?.(clientX, clientY);
      if (pos && el.contains(pos.offsetNode)) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      } else {
        const r = document.caretRangeFromPoint?.(clientX, clientY);
        if (r && el.contains(r.startContainer)) range = r;
      }
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ---------- Borrador ----------
  function startDraft(o: TextOverlay, isNew: boolean, clientX?: number, clientY?: number) {
    draft = { overlay: { ...o, cover: o.cover ? { ...o.cover } : null }, isNew, original: JSON.stringify(o) };
    renderOverlays();
    requestAnimationFrame(() => focusDraft(clientX, clientY));
  }

  /** Guarda el borrador (si hay cambios). */
  function finishDraft() {
    if (!draft) return;
    const d = draft;
    draft = null;
    const page = currentPage();
    if (!page) return;
    const { text, removed } = cleanText(d.overlay.text);
    if (removed.length) {
      host.toast(`Se han quitado caracteres que el PDF no puede guardar: ${removed.join(' ')}`, 'error');
    }
    const overlay = { ...d.overlay, text };
    // Un texto nuevo sin escribir nada y sin parche no sirve para nada.
    const keep = text.trim() !== '' || overlay.cover !== null;
    const exists = page.overlays.some((o) => o.id === overlay.id);
    let next: TextOverlay[];
    if (!keep) next = page.overlays.filter((o) => o.id !== overlay.id);
    else if (exists) next = page.overlays.map((o) => (o.id === overlay.id ? overlay : o));
    else next = [...page.overlays, overlay];

    const changed = d.isNew ? keep : JSON.stringify(overlay) !== d.original || !keep;
    if (changed) host.commit(setOverlays(host.getPages(), page.id, next));
    else renderOverlays();
  }

  /** Descarta el borrador. Devuelve true si había uno. */
  function cancelDraft(): boolean {
    if (!draft) return false;
    draft = null;
    renderOverlays();
    return true;
  }

  function removeDraft() {
    if (!draft) return;
    const id = draft.overlay.id;
    const wasNew = draft.isNew;
    draft = null;
    const page = currentPage();
    if (!page) return;
    if (wasNew) {
      renderOverlays();
      return;
    }
    host.commit(setOverlays(host.getPages(), page.id, page.overlays.filter((o) => o.id !== id)));
    host.toast('Texto quitado · puedes deshacer');
  }

  function onTextKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      finishDraft();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelDraft();
    }
  }

  // ---------- Mover ----------
  function startMove(e: PointerEvent, wrap: HTMLElement) {
    if (!draft || !viewport) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const [sx, sy] = layerPoint(e);
    let dx = 0;
    let dy = 0;
    props.hidden = true;
    const move = (ev: PointerEvent) => {
      const [x, y] = layerPoint(ev);
      dx = x - sx;
      dy = y - sy;
      wrap.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      if (!draft || !viewport) return;
      const [x0, y0] = viewToPdf(viewport, 0, 0);
      const [x1, y1] = viewToPdf(viewport, dx, dy);
      const o = draft.overlay;
      o.x += x1 - x0;
      o.y += y1 - y0;
      if (o.cover) {
        o.cover.x += x1 - x0;
        o.cover.y += y1 - y0;
      }
      renderOverlays();
      requestAnimationFrame(() => focusDraft());
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  // ---------- Crear overlays ----------
  function sampleColors(zone: Rect): { bg: string; ink: string } {
    const { border, inside } = samplePixels(canvas, viewport!, zone);
    const bg = dominantColor(border);
    return { bg, ink: inkColor(inside, bg) };
  }

  function replaceText(run: TextRun, clientX: number, clientY: number) {
    const vp = viewport!;
    const { font, bold } = guessFont(fontHint(run.fontName));
    const { bg, ink } = sampleColors(rectToView(vp, run.box));
    const size = Math.round(run.size * 2) / 2;
    startDraft(
      {
        id: newOverlayId(),
        x: run.x,
        y: run.y,
        angle: run.angle,
        text: run.str,
        size,
        font,
        bold,
        color: ink,
        cover: { ...run.box, color: bg },
      },
      true,
      clientX,
      clientY,
    );
  }

  /** Tamaño habitual de la letra en esta página (para "Añadir texto"). */
  function typicalSize(): number {
    if (lastAddSize) return lastAddSize;
    if (!runs.length) return 12;
    const sizes = runs.map((r) => r.size).sort((a, b) => a - b);
    return Math.round(sizes[Math.floor(sizes.length / 2)] * 2) / 2;
  }

  function addText(x: number, y: number) {
    const vp = viewport!;
    const size = typicalSize();
    // El clic queda más o menos a media altura de la letra.
    const [px, py] = viewToPdf(vp, x, y + size * vp.scale * 0.35);
    startDraft(
      {
        id: newOverlayId(),
        x: px,
        y: py,
        angle: vp.rotation,
        text: '',
        size,
        font: 'helvetica',
        bold: false,
        color: '#000000',
        cover: null,
      },
      true,
    );
  }

  function coverZone(zone: Rect) {
    const vp = viewport!;
    const pdfZone = rectToPdf(vp, zone);
    const zoneHeightPt = zone.h / vp.scale;
    const size = suggestFontSize(zoneHeightPt);
    const capPx = size * 0.7 * vp.scale;
    const [px, py] = viewToPdf(vp, zone.x + size * 0.15 * vp.scale, zone.y + zone.h / 2 + capPx / 2);
    const { bg } = sampleColors(zone);
    startDraft(
      {
        id: newOverlayId(),
        x: px,
        y: py,
        angle: vp.rotation,
        text: '',
        size,
        font: 'helvetica',
        bold: false,
        color: '#000000',
        cover: { ...pdfZone, color: bg },
      },
      true,
    );
  }

  // ---------- Eventos sobre la página ----------
  const onOverlay = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>('.ov');

  layer.addEventListener('pointermove', (e) => {
    if (mode !== 'replace' || !viewport || onOverlay(e) || draft) {
      hover.hidden = true;
      return;
    }
    const [x, y] = layerPoint(e);
    const [px, py] = viewToPdf(viewport, x, y);
    const run = runAt(runs, px, py);
    layer.classList.toggle('over-text', !!run);
    if (!run) {
      hover.hidden = true;
      return;
    }
    const r = rectToView(viewport, run.box);
    Object.assign(hover.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    hover.hidden = false;
  });
  layer.addEventListener('pointerleave', () => (hover.hidden = true));

  layer.addEventListener('pointerdown', (e) => {
    if (!viewport || e.button !== 0) return;
    const ovEl = onOverlay(e);
    // Clic dentro del texto que se está editando: dejar que el navegador mueva el cursor.
    if (ovEl?.classList.contains('editing')) return;

    if (ovEl) {
      // Editar un texto añadido antes.
      e.preventDefault();
      finishDraft();
      const o = currentPage()?.overlays.find((x) => x.id === ovEl.dataset.id);
      if (o) startDraft(o, false, e.clientX, e.clientY);
      return;
    }
    if (draft) {
      // El primer clic fuera solo termina de editar (evita crear cosas sin querer).
      e.preventDefault();
      finishDraft();
      return;
    }

    const [x, y] = layerPoint(e);
    if (mode === 'replace') {
      e.preventDefault();
      const [px, py] = viewToPdf(viewport, x, y);
      const run = runAt(runs, px, py);
      if (run) replaceText(run, e.clientX, e.clientY);
      else host.toast(runs.length ? 'Ahí no hay texto. Para escribir en un hueco, usa «Añadir texto».' : NO_TEXT_HINT);
    } else if (mode === 'add') {
      e.preventDefault();
      addText(x, y);
    } else {
      e.preventDefault();
      startMarquee(e, x, y);
    }
  });

  function startMarquee(e: PointerEvent, sx: number, sy: number) {
    layer.setPointerCapture(e.pointerId);
    let zone: Rect = { x: sx, y: sy, w: 0, h: 0 };
    const draw = () => {
      Object.assign(marquee.style, {
        left: `${zone.x}px`,
        top: `${zone.y}px`,
        width: `${zone.w}px`,
        height: `${zone.h}px`,
      });
    };
    marquee.hidden = false;
    draw();
    const move = (ev: PointerEvent) => {
      const [x, y] = layerPoint(ev);
      const cx = Math.max(0, Math.min(viewport!.width, x));
      const cy = Math.max(0, Math.min(viewport!.height, y));
      zone = { x: Math.min(sx, cx), y: Math.min(sy, cy), w: Math.abs(cx - sx), h: Math.abs(cy - sy) };
      draw();
    };
    const up = () => {
      layer.removeEventListener('pointermove', move);
      layer.removeEventListener('pointerup', up);
      layer.removeEventListener('pointercancel', up);
      marquee.hidden = true;
      if (zone.w < 8 || zone.h < 6) {
        host.toast('Mantén pulsado y arrastra para marcar la zona que quieres tapar.');
        return;
      }
      coverZone(zone);
    };
    layer.addEventListener('pointermove', move);
    layer.addEventListener('pointerup', up);
    layer.addEventListener('pointercancel', up);
  }

  // ---------- Panel de ajustes del texto ----------
  props.innerHTML = `
    <div class="pp-group" role="group" aria-label="Tamaño de letra">
      <button type="button" class="pp-btn" data-prop="smaller" title="Letra más pequeña">A−</button>
      <span class="pp-size" data-out="size"></span>
      <button type="button" class="pp-btn" data-prop="bigger" title="Letra más grande">A+</button>
    </div>
    <button type="button" class="pp-btn pp-bold" data-prop="bold" title="Negrita" aria-pressed="false">N</button>
    <select class="pp-select" data-prop="font" title="Tipo de letra" aria-label="Tipo de letra">
      <option value="helvetica">Helvetica</option>
      <option value="times">Times</option>
    </select>
    <div class="pp-group" role="group" aria-label="Color de la letra">
      ${COLORS.map((c) => `<button type="button" class="pp-swatch" data-color="${c.hex}" title="${c.name}" style="--c:${c.hex}"></button>`).join('')}
      <label class="pp-color" title="Otro color"><input type="color" data-prop="color" aria-label="Otro color" /></label>
    </div>
    <label class="pp-bg" title="Color del parche que tapa el fondo">Fondo <input type="color" data-prop="bg" /></label>
    <button type="button" class="pp-btn pp-danger" data-prop="remove" title="Quitar este texto">${icon('trash')} Quitar</button>
    <button type="button" class="pp-btn pp-done" data-prop="done">${icon('check')} Hecho</button>`;

  // Que pulsar los botones no quite el foco del texto.
  props.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('button')) e.preventDefault();
  });
  props.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t || !draft) return;
    const o = draft.overlay;
    const prop = t.dataset.prop;
    if (t.dataset.color) o.color = t.dataset.color;
    else if (prop === 'smaller') o.size = Math.max(4, Math.ceil(o.size) - 1);
    else if (prop === 'bigger') o.size = Math.min(96, Math.floor(o.size) + 1);
    else if (prop === 'bold') o.bold = !o.bold;
    else if (prop === 'remove') return removeDraft();
    else if (prop === 'done') return finishDraft();
    rerenderDraft();
  });
  props.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    if (!draft) return;
    if (t.dataset.prop === 'font') draft.overlay.font = t.value as TextOverlay['font'];
    else if (t.dataset.prop === 'color') draft.overlay.color = t.value;
    else if (t.dataset.prop === 'bg' && draft.overlay.cover) draft.overlay.cover.color = t.value;
    rerenderDraft(false);
  });

  function rerenderDraft(refocus = true) {
    renderOverlays();
    if (refocus) requestAnimationFrame(() => focusDraft());
  }

  function renderProps() {
    props.hidden = !draft;
    if (!draft) return;
    const o = draft.overlay;
    props.querySelector('[data-out="size"]')!.textContent = `${o.size}`;
    const bold = props.querySelector('[data-prop="bold"]')!;
    bold.classList.toggle('on', o.bold);
    bold.setAttribute('aria-pressed', String(o.bold));
    props.querySelector<HTMLSelectElement>('[data-prop="font"]')!.value = o.font;
    props.querySelectorAll<HTMLElement>('.pp-swatch').forEach((s) => s.classList.toggle('on', s.dataset.color === o.color));
    props.querySelector<HTMLInputElement>('[data-prop="color"]')!.value = o.color;
    const bg = props.querySelector<HTMLElement>('.pp-bg')!;
    bg.hidden = !o.cover;
    if (o.cover) bg.querySelector('input')!.value = o.cover.color;
  }

  /** Coloca el panel encima del texto que se edita (o debajo si no cabe). */
  function placeProps(wrap: HTMLElement) {
    if (props.hidden) return;
    const pageRect = pageBox.getBoundingClientRect();
    const parts = [...wrap.querySelectorAll<HTMLElement>('.ov-cover, .ov-box')].map((el) => el.getBoundingClientRect());
    const top = Math.min(...parts.map((r) => r.top)) - pageRect.top;
    const bottom = Math.max(...parts.map((r) => r.bottom)) - pageRect.top;
    const left = Math.min(...parts.map((r) => r.left)) - pageRect.left;
    const h = props.offsetHeight;
    const w = props.offsetWidth;
    const y = top - h - 10 >= 0 ? top - h - 10 : bottom + 10;
    props.style.top = `${y}px`;
    props.style.left = `${Math.max(0, Math.min(left, pageBox.clientWidth - w))}px`;
  }

  // ---------- Barra superior ----------
  btnBack.addEventListener('click', close);
  btnPrev.addEventListener('click', () => go(-1));
  btnNext.addEventListener('click', () => go(1));
  toolButtons.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as Mode)));

  function go(delta: number) {
    finishDraft();
    const pages = host.getPages();
    const next = pages[pageIndex() + delta];
    if (next) open(next.id);
  }

  document.addEventListener('keydown', (e) => {
    if (!pageId) return;
    const el = e.target as HTMLElement;
    if (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
    if (e.key === 'Escape') {
      if (!cancelDraft()) close();
    }
  });

  let resizeTimer: number | undefined;
  window.addEventListener('resize', () => {
    if (!pageId) return;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      finishDraft();
      renderedKey = -1;
      refresh();
    }, 250);
  });

  setMode('replace');

  return {
    open,
    close,
    refresh,
    get isOpen() {
      return pageId !== null;
    },
    /** Guarda lo que se esté escribiendo (antes de descargar, por ejemplo). */
    flush: finishDraft,
    /** Si se está escribiendo, "Deshacer" descarta ese texto. */
    cancelDraft,
    get hasDraft() {
      return draft !== null;
    },
  };
}

export type PageEditor = ReturnType<typeof createPageEditor>;
