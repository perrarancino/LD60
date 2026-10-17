import { defineConfig } from 'vite';

export default defineConfig({
  // Относительные пути (base: './') необходимы для корректной работы игры на Itch.io и GitHub Pages
  base: './',
  server: {
    port: 3000,
    open: true
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
    sourcemap: true
  }
});
