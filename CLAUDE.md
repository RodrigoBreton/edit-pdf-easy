# PDF Fácil (edit-pdf-easy)

Editor de PDF web, sencillo, para una persona **no técnica** (un familiar de Rodro).
Todo ocurre en el navegador: los PDFs nunca se suben a ningún servidor.

## Stack
- Vite + TypeScript (sin framework). Ejecuta con `npm run dev`.
- **pdf.js** (`pdfjs-dist`) para renderizar páginas → `src/core/render.ts`.
- **pdf-lib** para generar el PDF resultante → `src/core/exportPdf.ts`.
- **SortableJS** para arrastrar y reordenar miniaturas.
- Tests con Vitest (`npm test`). Despliegue automático a GitHub Pages en cada push a `main` (`.github/workflows/deploy.yml`).

## Arquitectura
- `src/core/` = lógica pura, sin DOM cuando se pueda. Tiene tests en `tests/`.
  - `pages.ts`: el documento se modela como una lista de `PageRef` (página original + rotación). El PDF original **no se toca** hasta exportar.
  - `History`: pila de estados para "Deshacer".
- `src/main.ts` = UI (estado, render de tarjetas, eventos). Las tarjetas se cachean por id para no re-renderizar miniaturas al reordenar.

## Reglas de producto (importantes)
- Textos de la interfaz en **español**, lenguaje llano ("Quitar", no "Eliminar del documento").
- Botones grandes (≥ 40 px), pocas opciones a la vista.
- **Nunca sobrescribir el original**: siempre se descarga una copia `nombre (editado).pdf`.
- Toda acción destructiva debe poder deshacerse (Ctrl/Cmd+Z y botón).
- Avisar antes de cerrar o abrir otro PDF si hay cambios sin descargar.
- Nada de backend, analítica ni peticiones externas con el contenido del PDF.

## Fases
1. ✅ Gestión de páginas: abrir, miniaturas, reordenar, quitar, girar, sacar selección a PDF aparte, descargar.
2. ⏳ Editar fecha/valor: seleccionar zona → rectángulo del color de fondo → texto encima (fuente y tamaño ajustables). Mismo enfoque de "capas" que se aplican al exportar.
3. ⏳ Firma: dibujar o subir imagen, guardarla en el navegador (localStorage), colocar y redimensionar.
4. ⏳ Extras: unir varios PDFs, separar en archivos sueltos (zip), rellenar formularios.

## Convenciones
- Antes de dar algo por terminado: `npm test` y `npm run build` en verde.
- Commits pequeños y descriptivos, en español.
