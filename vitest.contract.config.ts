import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/*.integration.test.ts', '**/*.e2e.spec.ts', '**/node_modules/**', '**/out/**'],
    include: ['**/*.contract.test.ts'],
    passWithNoTests: false,
  },
});
