import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/*.contract.test.ts', '**/*.e2e.spec.ts', '**/node_modules/**', '**/out/**'],
    fileParallelism: false,
    include: ['**/*.integration.test.ts'],
    maxWorkers: 1,
    passWithNoTests: false,
  },
});
