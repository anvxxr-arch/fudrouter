import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  envPrefix: ['VITE_', 'PUBLIC_'],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // Vite inlines every asset under 4 kB as a data: URI. The webfonts' small
    // subsets (cyrillic, greek, vietnamese) fall under that threshold, and the
    // edge CSP is `font-src 'self'` -- so each inlined subset was refused and
    // the console filled with one CSP violation per subset. Emitting every
    // asset as a real file keeps the strict policy exactly as written instead
    // of widening it to `font-src 'self' data:`. Measured: 12 refused fonts
    // before, 0 after.
    assetsInlineLimit: 0,
  },
});
