import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: [
      '**/*.contract.test.ts',
      '**/*.integration.test.ts',
      '**/*.e2e.spec.ts',
      '**/node_modules/**',
      '**/out/**',
    ],
    include: ['**/*.test.ts', '**/*.test.tsx'],
    passWithNoTests: false,
  },
});
