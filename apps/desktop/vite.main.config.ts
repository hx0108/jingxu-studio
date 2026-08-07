import path from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: path.resolve(import.meta.dirname, 'src/main/main.ts'),
      fileName: () => 'main.js',
      formats: ['cjs'],
    },
    outDir: path.resolve(import.meta.dirname, '.vite/build'),
    rollupOptions: {
      external: ['better-sqlite3', 'electron', /^node:/u],
    },
    target: 'node22',
  },
});
