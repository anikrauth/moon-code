import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

/* Build-only: the dev server needs the inline react-refresh preamble, which
   script-src 'self' would block. Packaged renderer loads over file:// where
   response headers aren't available, so the policy ships as a meta tag. */
const injectCsp = () => ({
  name: 'inject-csp',
  apply: 'build' as const,
  transformIndexHtml(html: string) {
    return {
      html,
      tags: [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
          },
          injectTo: 'head-prepend' as const,
        },
      ],
    };
  },
});

export default defineConfig({
  plugins: [react(), injectCsp()],
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
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) return 'vendor-react';
          if (id.includes('node_modules/highlight.js')) return 'vendor-highlight';
          if (id.includes('node_modules/react-markdown') || id.includes('node_modules/remark-gfm')) return 'vendor-markdown';
          if (id.includes('node_modules/@json-render')) return 'vendor-jsonrender';
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
