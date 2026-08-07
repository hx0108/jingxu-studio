import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

const collectTypeScriptFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) return collectTypeScriptFiles(target);
      return entry.isFile() && /\.tsx?$/u.test(entry.name) ? [target] : [];
    }),
  );
  return nested.flat();
};

const assertFilesExclude = async (root: string, forbidden: RegExp): Promise<void> => {
  const files = await collectTypeScriptFiles(root);
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    expect(content, path.relative(repositoryRoot, file)).not.toMatch(forbidden);
  }
};

describe('跨包依赖边界', () => {
  it('Application 源码—检查依赖—不导入 persistence 或 SQLite', async () => {
    await assertFilesExclude(
      path.join(repositoryRoot, 'packages', 'application', 'src'),
      /@jingxu\/persistence|better-sqlite3|node:sqlite/u,
    );
  });

  it('Renderer 源码—检查依赖—不导入 Application 实现或基础设施', async () => {
    await assertFilesExclude(
      path.join(repositoryRoot, 'apps', 'desktop', 'src', 'renderer'),
      /@jingxu\/(application|persistence)|better-sqlite3|node:/u,
    );
  });

  it('Main 构建—处理原生 SQLite—将 better-sqlite3 保持为运行时外部依赖', async () => {
    const viteMainConfig = await readFile(
      path.join(repositoryRoot, 'apps', 'desktop', 'vite.main.config.ts'),
      'utf8',
    );

    expect(viteMainConfig).toMatch(/external:\s*\[[^\]]*'better-sqlite3'/su);
  });
});
