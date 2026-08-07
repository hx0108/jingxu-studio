import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const sharedTypeScriptRules = {
  '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'error',
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['@jingxu/*/src/*'],
          message: '跨包只能使用公开入口，禁止深层导入其他包的 src。',
        },
      ],
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '.agents/**',
      '.vite/**',
      '**/dist/**',
      'node_modules/**',
      'openspec/**',
      'out/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      ...sharedTypeScriptRules,
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: 'Renderer 只能通过 window.jingxu 使用白名单能力。',
            },
            {
              name: 'better-sqlite3',
              message: 'Renderer 不得直接访问数据库。',
            },
          ],
          patterns: [
            {
              group: ['node:*', '@jingxu/*/src/*', '**/main/**', '**/preload/**'],
              message: 'Renderer 不得导入 Node、Main、Preload 或跨包私有实现。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/desktop/src/preload/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@jingxu/*/src/*', '**/main/**', '**/renderer/**'],
              message: 'Preload 只能依赖 Electron 与公开 Contract。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/desktop/src/main/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@jingxu/*/src/*', '**/renderer/**'],
              message: 'Main 不得依赖 Renderer 或跨包私有实现。',
            },
          ],
        },
      ],
    },
  },
);
