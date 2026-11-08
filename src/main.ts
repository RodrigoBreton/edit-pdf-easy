import './style.css';
import Sortable from 'sortablejs';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import { openPdf, paintOverlays, renderThumbnail, type OpenedPdf } from './core/render';
import { createPageEditor } from './editor/pageEditor';
import { setupThemeSwitch } from './themeSwitch';
import type { TextOverlay } from './core/overlays';
import { buildPdf, downloadBytes, outputName } from './core/exportPdf';
import {
  History,
  createPages,
  movePage,
  pickPages,
  removePages,
  rotatePages,
  type PageRef,
} from './core/pages';

// ---------- Estado ----------
interface State {
  fileName: string;
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
  close: OpenedPdf['close'];
  pages: PageRef[];
  selected: Set<string>;
  dirty: boolean;
}

let state: State | null = null;
const history = new History<PageRef[]>();
/** Tarjetas ya creadas, para no volver a renderizar miniaturas al reordenar. */
const cards = new Map<string, HTMLElement>();
/** Miniatura sin textos añadidos, para poder volver a pintarlos encima al cambiar. */
interface Thumb {
  viewport: PageViewport;
  pristine: HTMLCanvasElement;
  painted: TextOverlay[] | null;
}
const thumbs = new Map<string, Thumb>();

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
setupThemeSwitch($<HTMLButtonElement>('theme-switch'));
const welcome = $('welcome');
const editor = $('editor');
const dropzone = $('dropzone');
const fileInput = $<HTMLInputElement>('file-input');
const grid = $('grid');
const fileNameEl = $('file-name');
const pageCountEl = $('page-count');
const selectionInfo = $('selection-info');
const toastEl = $('toast');
const loadingEl = $('loading');
const pagesView = $('pages-view');

const btn = {
  undo: $<HTMLButtonElement>('btn-undo'),
  open: $<HTMLButtonElement>('btn-open'),
  download: $<HTMLButtonElement>('btn-download'),
  selectAll: $<HTMLButtonElement>('btn-select-all'),
  selectNone: $<HTMLButtonElement>('btn-select-none'),
  rotateSel: $<HTMLButtonElement>('btn-rotate-sel'),
  deleteSel: $<HTMLButtonElement>('btn-delete-sel'),
  extractSel: $<HTMLButtonElement>('btn-extract-sel'),
};

// ---------- Utilidades UI ----------
let toastTimer: number | undefined;
function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  toastEl.textContent = message;
  toastEl.classList.toggle('error', kind === 'error');
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 3500);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ---------- Carga de archivo ----------
async function loadFile(file: File): Promise<void> {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    toast('Ese archivo no es un PDF.', 'error');
    return;
  }
  if ((state?.dirty || pageEditor.hasDraft) && !confirm('Tienes cambios sin descargar. ¿Abrir otro PDF de todas formas?')) {
    return;
  }

  loadingEl.hidden = false;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { doc, close } = await openPdf(bytes);
    pageEditor.close();
    state?.close();
    state = {
      fileName: file.name,
      bytes,
      doc,
      close,
      pages: createPages(doc.numPages),
      selected: new Set(),
      dirty: false,
    };
    history.clear();
    cards.clear();
    thumbs.clear();
    grid.innerHTML = '';
    welcome.hidden = true;
    editor.hidden = false;
    fileNameEl.textContent = file.name;
    render();
  } catch (err) {
    console.error(err);
    const msg = String((err as Error)?.name ?? '').includes('Password')
      ? 'Este PDF está protegido con contraseña y no se puede abrir.'
      : 'No se ha podido abrir el PDF. Puede que esté dañado.';
    toast(msg, 'error');
  } finally {
    loadingEl.hidden = true;
  }
}

// ---------- Cambios de estado ----------
function commit(nextPages: PageRef[]): void {
  if (!state) return;
  history.push(state.pages);
  state.pages = nextPages;
  state.dirty = true;
  // Limpiar selección de páginas que ya no existen.
  const alive = new Set(nextPages.map((p) => p.id));
  state.selected = new Set([...state.selected].filter((id) => alive.has(id)));
  render();
}

function undo(): void {
  if (!state) return;
  // Si se está escribiendo un texto, "Deshacer" lo descarta.
  if (pageEditor.cancelDraft()) {
    toast('Texto descartado');
    return;
  }
  const prev = history.pop();
  if (!prev) return;
  state.pages = prev;
  state.dirty = true;
  render();
  toast('Cambio deshecho');
}

function toggleSelect(id: string): void {
  if (!state) return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

function deletePages(ids: Set<string>): void {
  if (!state || ids.size === 0) return;
  if (ids.size >= state.pages.length) {
    toast('No puedes quitar todas las páginas: el PDF se quedaría vacío.', 'error');
    return;
  }
  commit(removePages(state.pages, ids));
  toast(`${plural(ids.size, 'página quitada', 'páginas quitadas')} · puedes deshacer`);
}

// ---------- Render ----------
function createCard(page: PageRef): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = page.id;
  card.tabIndex = 0;
  card.innerHTML = `
    <span class="check" aria-hidden="true">✓</span>
    <span class="badge" title="Tiene textos cambiados" hidden>✎ editada</span>
    <div class="thumb"><canvas></canvas></div>
    <div class="meta">
      <span class="num"></span>
      <div class="tools">
        <button class="icon-btn" data-action="edit" title="Cambiar texto de esta página">✎</button>
        <button class="icon-btn" data-action="rotate" title="Girar">↻</button>
        <button class="icon-btn danger" data-action="delete" title="Quitar página">🗑</button>
      </div>
    </div>`;

  const canvas = card.querySelector('canvas')!;
  if (state) {
    const doc = state.doc;
    renderThumbnail(doc, page.sourceIndex, canvas)
      .then((viewport) => {
        if (state?.doc !== doc) return;
        const pristine = document.createElement('canvas');
        pristine.width = canvas.width;
        pristine.height = canvas.height;
        pristine.getContext('2d')!.drawImage(canvas, 0, 0);
        thumbs.set(page.id, { viewport, pristine, painted: null });
        const current = state.pages.find((p) => p.id === page.id);
        if (current) updateThumb(current, canvas);
      })
      .catch((e) => console.error(e));
  }
  return card;
}

/** Pinta en la miniatura los textos añadidos (solo si han cambiado). */
function updateThumb(page: PageRef, canvas: HTMLCanvasElement): void {
  const thumb = thumbs.get(page.id);
  if (!thumb || thumb.painted === page.overlays) return;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(thumb.pristine, 0, 0);
  paintOverlays(canvas, thumb.viewport, page.overlays);
  thumb.painted = page.overlays;
}

function render(): void {
  if (!state) return;
  const { pages, selected } = state;

  // Reordenar/crear tarjetas según el estado (sin re-renderizar miniaturas).
  const alive = new Set<string>();
  pages.forEach((page, i) => {
    alive.add(page.id);
    let card = cards.get(page.id);
    if (!card) {
      card = createCard(page);
      cards.set(page.id, card);
    }
    card.querySelector('.num')!.textContent = `Página ${i + 1}`;
    card.classList.toggle('selected', selected.has(page.id));
    card.setAttribute('aria-pressed', String(selected.has(page.id)));
    const canvas = card.querySelector('canvas')!;
    canvas.style.transform = page.rotation ? `rotate(${page.rotation}deg)` : '';
    updateThumb(page, canvas);
    card.querySelector<HTMLElement>('.badge')!.hidden = page.overlays.length === 0;
    grid.appendChild(card); // appendChild mueve el nodo si ya existe
  });
  for (const [id, card] of cards) {
    if (!alive.has(id)) {
      // Lo conservamos en el mapa por si se deshace el borrado.
      card.remove();
    }
  }

  pageCountEl.textContent = plural(pages.length, 'página', 'páginas');
  const n = selected.size;
  selectionInfo.textContent =
    n === 0
      ? 'Haz clic en las páginas para seleccionarlas. Arrástralas para cambiar el orden. Doble clic para cambiar su texto.'
      : `${plural(n, 'página seleccionada', 'páginas seleccionadas')}`;

  btn.undo.disabled = !history.canUndo;
  btn.selectNone.disabled = n === 0;
  btn.selectAll.disabled = n === pages.length;
  btn.rotateSel.disabled = n === 0;
  btn.deleteSel.disabled = n === 0;
  btn.extractSel.disabled = n === 0;

  if (pageEditor.isOpen && !pageEditor.hasDraft) pageEditor.refresh();
}

// ---------- Descargas ----------
async function download(pages: PageRef[], suffix: string): Promise<void> {
  if (!state) return;
  try {
    btn.download.disabled = true;
    const bytes = await buildPdf(state.bytes, pages);
    downloadBytes(bytes, outputName(state.fileName, suffix));
    if (pages === state.pages) state.dirty = false;
    toast('PDF descargado ✔');
  } catch (err) {
    console.error(err);
    toast('No se ha podido generar el PDF.', 'error');
  } finally {
    btn.download.disabled = false;
  }
}

// ---------- Editor de texto ----------
const pageEditor = createPageEditor({
  getDoc: () => state?.doc ?? null,
  getPages: () => state?.pages ?? [],
  commit,
  toast,
  onToggle: (open) => {
    pagesView.hidden = open;
    if (!open) render();
  },
});

// ---------- Eventos ----------
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('over');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  const file = e.dataTransfer?.files[0];
  if (file) loadFile(file);
});
// Permitir soltar un PDF en cualquier parte de la ventana.
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  loadFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file);
  fileInput.value = '';
});

btn.open.addEventListener('click', () => fileInput.click());
btn.undo.addEventListener('click', undo);
btn.download.addEventListener('click', () => {
  if (!state) return;
  pageEditor.flush(); // guardar el texto que se esté escribiendo
  download(state.pages, 'editado');
});
btn.selectAll.addEventListener('click', () => {
  if (!state) return;
  state.selected = new Set(state.pages.map((p) => p.id));
  render();
});
btn.selectNone.addEventListener('click', () => {
  if (!state) return;
  state.selected.clear();
  render();
});
btn.rotateSel.addEventListener('click', () => state && commit(rotatePages(state.pages, state.selected)));
btn.deleteSel.addEventListener('click', () => state && deletePages(new Set(state.selected)));
btn.extractSel.addEventListener('click', () => {
  if (!state) return;
  download(pickPages(state.pages, state.selected), `${state.selected.size} pág.`);
});

grid.addEventListener('click', (e) => {
  if (!state) return;
  const target = e.target as HTMLElement;
  const card = target.closest<HTMLElement>('.card');
  if (!card) return;
  const id = card.dataset.id!;
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action === 'edit') pageEditor.open(id);
  else if (action === 'rotate') commit(rotatePages(state.pages, new Set([id])));
  else if (action === 'delete') deletePages(new Set([id]));
  else toggleSelect(id);
});

grid.addEventListener('dblclick', (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
  if (!card || (e.target as HTMLElement).closest('[data-action]')) return;
  pageEditor.open(card.dataset.id!);
});

grid.addEventListener('keydown', (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
  if (card && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    toggleSelect(card.dataset.id!);
  }
});

document.addEventListener('keydown', (e) => {
  if (!state) return;
  const el = e.target as HTMLElement;
  // Mientras se escribe, Ctrl+Z y Retroceso son del propio texto.
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
  } else if (pageEditor.isOpen) {
    return;
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected.size) {
    e.preventDefault();
    deletePages(new Set(state.selected));
  }
});

Sortable.create(grid, {
  animation: 150,
  ghostClass: 'sortable-ghost',
  chosenClass: 'sortable-chosen',
  filter: '.icon-btn',
  preventOnFilter: false,
  onEnd: (evt) => {
    if (!state || evt.oldIndex == null || evt.newIndex == null || evt.oldIndex === evt.newIndex) return;
    commit(movePage(state.pages, evt.oldIndex, evt.newIndex));
  },
});

window.addEventListener('beforeunload', (e) => {
  if (state?.dirty || pageEditor.hasDraft) e.preventDefault();
});
