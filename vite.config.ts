import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  resolve: {
    alias: {
      '@app': resolve(__dirname, 'src/renderer/app'),
      '@pages': resolve(__dirname, 'src/renderer/pages'),
      '@widgets': resolve(__dirname, 'src/renderer/widgets'),
      '@features': resolve(__dirname, 'src/renderer/features'),
      '@entities': resolve(__dirname, 'src/renderer/entities'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
