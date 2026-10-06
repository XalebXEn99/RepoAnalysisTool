import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// The client lives in src/client; the dev server proxies /api to the Express
// backend so the browser only ever talks to one origin.
export default defineConfig({
  root: path.resolve(__dirname, 'src/client'),
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
});
