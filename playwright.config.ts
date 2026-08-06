import { defineConfig } from '@playwright/test';

export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  reporter: [['list']],
  testDir: '.',
  testIgnore: ['**/*.test.ts', '**/*.test.tsx', '**/node_modules/**', '**/out/**'],
  testMatch: ['**/*.e2e.spec.ts'],
  timeout: 30_000,
  use: {
    trace: 'retain-on-failure',
  },
  workers: 1,
});
