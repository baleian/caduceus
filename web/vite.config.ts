import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'

// Dev proxy targets the local daemon; production is same-origin (no proxy).
const DAEMON = 'http://127.0.0.1:4285'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../caduceus/web_dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    proxy: {
      '/api': { target: DAEMON, ws: true },
      '/v1': { target: DAEMON },
      '/agents': { target: DAEMON },
      '/healthz': { target: DAEMON },
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts?(x)', 'tests/property/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
})
