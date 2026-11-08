import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      includeAssets: ['icon.svg', 'samples/*.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,ttf}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      manifest: {
        name: 'MosaicPlan',
        short_name: 'MosaicPlan',
        description: 'Fotos in Glas- und Keramikmosaike mit Verlegeplan umwandeln',
        lang: 'de',
        theme_color: '#1d2a3a',
        background_color: '#f4f1ec',
        display: 'standalone',
        start_url: '.',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  // Ausdrücklich festgelegt (entspricht Vite 8 „baseline-widely-available“), damit ein Vite-Update die
  // Mindestversion nicht still verschiebt. Muss zu android.minWebViewVersion (capacitor.config.ts) und
  // zum Funktionstest in index.html passen.
  build: { target: ['chrome111', 'edge111', 'firefox114', 'safari16.4'] },
  worker: { format: 'es' },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120000,
  },
});
