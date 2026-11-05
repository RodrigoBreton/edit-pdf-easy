/**
 * Modelo de páginas del documento.
 *
 * No modificamos el PDF original mientras el usuario trabaja: guardamos una
 * lista de "referencias" a sus páginas (qué página original es y cuánto está
 * rotada). Solo al descargar generamos un PDF nuevo con pdf-lib.
 */
export interface PageRef {
  /** Identificador estable para la UI (no cambia al reordenar). */
  id: string;
  /** Índice (0-based) de la página en el PDF original. */
  sourceIndex: number;
  /** Rotación añadida por el usuario, en grados: 0, 90, 180 o 270. */
  rotation: number;
}

let counter = 0;
const newId = () => `p${++counter}`;

export function createPages(pageCount: number): PageRef[] {
  return Array.from({ length: pageCount }, (_, i) => ({
    id: newId(),
    sourceIndex: i,
    rotation: 0,
  }));
}

export function movePage(pages: PageRef[], from: number, to: number): PageRef[] {
  if (from === to || from < 0 || from >= pages.length || to < 0 || to >= pages.length) {
    return pages;
  }
  const next = [...pages];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function removePages(pages: PageRef[], ids: Set<string>): PageRef[] {
  return pages.filter((p) => !ids.has(p.id));
}

export function rotatePages(pages: PageRef[], ids: Set<string>, delta = 90): PageRef[] {
  return pages.map((p) =>
    ids.has(p.id) ? { ...p, rotation: (((p.rotation + delta) % 360) + 360) % 360 } : p,
  );
}

export function pickPages(pages: PageRef[], ids: Set<string>): PageRef[] {
  return pages.filter((p) => ids.has(p.id));
}

/** Historial simple para "Deshacer". */
export class History<T> {
  private stack: T[] = [];
  constructor(private readonly limit = 50) {}

  push(state: T): void {
    this.stack.push(state);
    if (this.stack.length > this.limit) this.stack.shift();
  }

  pop(): T | undefined {
    return this.stack.pop();
  }

  clear(): void {
    this.stack = [];
  }

  get canUndo(): boolean {
    return this.stack.length > 0;
  }
}
