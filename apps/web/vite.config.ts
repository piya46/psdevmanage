import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve('apps/web'),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': process.env.GATEWAY_URL ?? 'http://127.0.0.1:3000' },
  },
  build: { outDir: resolve('dist/web'), emptyOutDir: true },
});
