import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { DEVELOPMENT_CSP, PRODUCTION_CSP } from './src/main/security/content-security-policy';

const injectContentSecurityPolicy = (policy: string): Plugin => ({
  name: 'jingxu-content-security-policy',
  transformIndexHtml: (html) => html.replace('__JINGXU_CSP__', policy),
});

export default defineConfig(({ command }) => ({
  base: './',
  build: {
    emptyOutDir: true,
    outDir: path.resolve(import.meta.dirname, '.vite/renderer/main_window'),
  },
  plugins: [
    react(),
    injectContentSecurityPolicy(command === 'serve' ? DEVELOPMENT_CSP : PRODUCTION_CSP),
  ],
  root: path.resolve(import.meta.dirname, 'src/renderer'),
}));
