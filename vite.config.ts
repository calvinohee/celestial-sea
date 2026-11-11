import { defineConfig } from 'vite';

// Relative base so the build works under a GitHub Pages repo subpath.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  server: {
    host: true,
  },
});
