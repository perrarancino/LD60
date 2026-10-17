import { defineConfig } from 'vite';

export default defineConfig({
  // Crucial for Itch.io / Game Jam uploads: makes asset links relative
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
