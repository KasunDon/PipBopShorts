import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        // Long LLM calls (drift check, storyline generation, canon extraction)
        // can run for minutes; without generous timeouts the dev proxy drops the
        // socket mid-request and the browser surfaces a bare "Failed to fetch".
        // 0 = no timeout. `ws` keeps the SSE event/job streams alive.
        timeout: 0,
        proxyTimeout: 0,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
