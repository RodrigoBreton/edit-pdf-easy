# PDF Fácil (edit-pdf-easy)

Editor de PDF web, sencillo, para una persona **no técnica** (un familiar de Rodro) que necesita
a menudo: editar una fecha o un valor, añadir una firma, separar, reordenar y quitar páginas.
Todo ocurre en el navegador: los PDFs nunca se suben a ningún servidor.

- Repo: https://github.com/RodrigoBreton/edit-pdf-easy (público, rama `main`)
- Web publicada: https://rodrigobreton.github.io/edit-pdf-easy/
- Rodro es Product Owner con background Java/Angular: explícale las decisiones técnicas con claridad,
  pero no hace falta simplificar en exceso. Habla con él en español y en tono cercano.

## Cómo arrancar
- Requiere **Node ≥ 20.19** (recomendado 22, hay `.nvmrc`). Con Node 20.6 Vite 8 falla con
  `node:util does not provide an export named 'styleText'`: es la versión de Node, no el código.
- `npm install` · `npm run dev` (http://localhost:5173) · `npm test` · `npm run build`

## Stack
- Vite 8 + TypeScript (sin framework, a propósito: app pequeña y fácil de leer).
- **pdf.js** (`pdfjs-dist` v6) para renderizar → `src/core/render.ts`.
  En v6 `destroy()` está en el *loading task*, no en el documento: por eso `openPdf` devuelve `{ doc, close }`.
- **pdf-lib** para generar el PDF resultante → `src/core/exportPdf.ts`.
- **SortableJS** para arrastrar y reordenar miniaturas.
- Vitest para tests (`tests/`).

## Arquitectura
- `src/core/` = lógica pura, sin DOM cuando se pueda, con tests.
  - `pages.ts`: el documento es una lista de `PageRef` `{ id, sourceIndex, rotation }`. Funciones puras
    (`movePage`, `removePages`, `rotatePages`, `pickPages`) que devuelven una lista nueva.
    El PDF original **no se toca** hasta exportar.
  - `History<T>`: pila de estados para "Deshacer" (límite 50).
  - `exportPdf.ts`: `buildPdf(bytes, pages)` copia páginas con pdf-lib y suma la rotación a la que
    ya tuviera la página; `outputName()` genera `nombre (editado).pdf`.
- `src/main.ts` = UI: estado global, render de tarjetas y eventos.
  - Cada cambio pasa por `commit(nextPages)` (guarda historial, marca `dirty` y re-renderiza).
  - Las tarjetas se cachean por id en `cards`: al reordenar o deshacer solo se mueven nodos del DOM,
    no se vuelven a pintar las miniaturas. La rotación en pantalla es un `transform` CSS.
- `.github/workflows/deploy.yml`: en cada push a `main` ejecuta `npm ci`, `npm test`, `npm run build`
  y publica `dist/` en GitHub Pages. Si fallan los tests, no se publica.
- `vite.config.ts` usa `base: './'` para que funcione bajo `/edit-pdf-easy/`.

## Reglas de producto (importantes)
- Textos de la interfaz en **español**, lenguaje llano ("Quitar", no "Eliminar del documento").
- Botones grandes (≥ 40 px), pocas opciones a la vista.
- **Nunca sobrescribir el original**: siempre se descarga una copia `nombre (editado).pdf`.
- Toda acción destructiva debe poder deshacerse (Ctrl/Cmd+Z y botón).
- Avisar antes de cerrar o abrir otro PDF si hay cambios sin descargar.
- No dejar el documento vacío (no se pueden quitar todas las páginas).
- Nada de backend, analítica ni peticiones externas con el contenido del PDF.

## Estado
### ✅ Fase 1 — Gestión de páginas (hecha, desplegada y probada en navegador real)
Abrir (clic o arrastrar a cualquier parte de la ventana), miniaturas, seleccionar (clic / Enter / Espacio),
reordenar arrastrando, girar, quitar (botón, tecla Supr/Retroceso), "Sacar a un PDF aparte" con las
seleccionadas, descargar, deshacer. Mensajes de error para PDFs no válidos o con contraseña.

### ✅ Fase 2 — Editar fecha/valor (hecha en local, pendiente de prueba de Rodro)
Enfoque: **tapar y escribir encima** (el texto original sigue en el PDF debajo del parche: se ve tapado,
pero se podría copiar/buscar). Vista ampliada (doble clic o ✎ en la miniatura) con tres herramientas:
- **Cambiar texto**: clic sobre un texto → se tapa con el color de fondo muestreado del canvas y aparece
  una caja con el texto original; se adivinan tamaño, color, Helvetica/Times y negrita.
  `buildTextRuns` une trozos pegados (PDFs que dibujan letra a letra).
- **Añadir texto**: clic en un hueco, sin fondo. **Tapar zona**: arrastrar un rectángulo (PDFs escaneados),
  tamaño de letra propuesto según la altura.
- Panel flotante: tamaño, negrita, fuente, color, color del parche, Quitar, Hecho. Asa ✥ para mover.
- Modelo: `PageRef.overlays: TextOverlay[]` (`src/core/overlays.ts`), en coordenadas del PDF (puntos,
  sin rotación de página) y con `angle` para que el texto quede derecho en la vista donde se escribió.
  `buildPdf` los dibuja con `drawRectangle` + `drawText`. Caracteres fuera de WinAnsi se quitan con aviso.
- Mientras se escribe es un "borrador"; se guarda con un solo `commit` (Intro, Hecho, clic fuera, cambiar
  de página, descargar). Escape o Deshacer lo descartan.
- UI en `src/editor/pageEditor.ts`; las miniaturas pintan los textos encima (`paintOverlays`).

### ⏳ Fase 3 — Firma
Dibujar con ratón/dedo o subir imagen (PNG con fondo transparente), guardarla en `localStorage`
para reutilizarla, colocarla y redimensionarla. Reutilizar el sistema de `overlays` de la fase 2.

### ⏳ Fase 4 — Extras (según pida el familiar)
Unir varios PDFs (requiere que `PageRef` apunte a varias fuentes, no solo a una), separar en archivos
sueltos (descargar un .zip; los navegadores bloquean muchas descargas seguidas), rellenar formularios.

## Limitaciones conocidas
- Solo un PDF de origen a la vez.
- El bundle pesa ~900 kB por pdf.js (normal; aviso de tamaño desactivado en `vite.config.ts`).
- No hay tests de UI en el repo. En la fase 1 se verificó con un script de Playwright aparte
  (abrir, girar, quitar, extraer, descargar y deshacer); si se añaden tests e2e, ir a `tests/e2e/`.

## Convenciones
- Antes de dar algo por terminado: `npm test` y `npm run build` en verde.
- Commits pequeños y descriptivos, en español.
- Commits **firmados/verificados**: GitHub debe mostrarlos como *Verified*, no *Unverified*.
