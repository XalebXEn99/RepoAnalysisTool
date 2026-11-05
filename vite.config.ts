import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// The client lives in src/client; the dev server proxies /api to the Express
// backend so the browser only ever talks to one origin.
export default defineConfig({
  root: path.resolve(root, 'src/client'),
  plugins: [react()],
  build: {
    outDir: path.resolve(root, 'dist/client'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
});
