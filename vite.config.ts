import { defineConfig } from 'vite';

// base relativa: funciona en GitHub Pages (usuario.github.io/edit-pdf-easy/) y en local.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 }, // pdf.js pesa, es normal
  test: { environment: 'node' },
});
