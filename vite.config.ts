import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

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
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'Celestial Sea',
        short_name: 'Celestial Sea',
        description: 'A calm sea at dusk. Release lanterns and watch them become your own constellations.',
        // Relative, so the app installs correctly from any subpath.
        start_url: '.',
        scope: '.',
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'any',
        background_color: '#0b1030',
        theme_color: '#0b1030',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache everything, audio samples included, so the game works offline after first load.
        globPatterns: ['**/*.{js,css,html,mp3,png,webmanifest}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
      },
    }),
  ],
});
