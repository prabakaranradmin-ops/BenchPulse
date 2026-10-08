import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Served by the API server at /admin/, so the app, the API and the /join/ landing page share one
// origin — one tunnel, no CORS, and join links can be built from window.location.
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  define: {
    // Where CesiumJS fetches its workers and assets (copied into public/ by scripts/copy-cesium.mjs).
    CESIUM_BASE_URL: JSON.stringify('/admin/cesium'),
  },
  server: {
    // `npm run dev` against a server on :3000 (docker compose up, or `npm run dev` in server/).
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/join': 'http://127.0.0.1:3000',
    },
  },
  build: {
    // CesiumJS is several megabytes on its own (lazy-loaded with the map screen); that is
    // expected for a desktop admin tool.
    chunkSizeWarningLimit: 6000,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
