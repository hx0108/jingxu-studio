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

  it('Renderer 源码—检查依赖—不导入 Application/Domain 实现或基础设施', async () => {
    await assertFilesExclude(
      path.join(repositoryRoot, 'apps', 'desktop', 'src', 'renderer'),
      /@jingxu\/(application|persistence|domain)|better-sqlite3|node:/u,
    );
  });

  it('Domain 源码—检查依赖—不导入 React/Electron/Zod/Node/SQLite 或其他 jingxu 包', async () => {
    await assertFilesExclude(
      path.join(repositoryRoot, 'packages', 'domain', 'src'),
      /from\s+['"]react['"]|from\s+['"]electron['"]|from\s+['"]zod['"]|node:sqlite|better-sqlite3|from\s+['"]node:|@jingxu\//u,
    );
  });

  it('Main 构建—处理内置 SQLite—保留 node: external 且不声明外部 SQLite addon', async () => {
    const [viteMainConfig, desktopPackage, persistencePackage, persistenceEntry] =
      await Promise.all([
        readFile(path.join(repositoryRoot, 'apps', 'desktop', 'vite.main.config.ts'), 'utf8'),
        readFile(path.join(repositoryRoot, 'apps', 'desktop', 'package.json'), 'utf8'),
        readFile(path.join(repositoryRoot, 'packages', 'persistence', 'package.json'), 'utf8'),
        readFile(path.join(repositoryRoot, 'packages', 'persistence', 'src', 'index.ts'), 'utf8'),
      ]);

    expect(viteMainConfig).toMatch(/external:\s*\[[^\]]*\/\^node:\//su);
    expect(`${viteMainConfig}\n${desktopPackage}\n${persistencePackage}`).not.toContain(
      'better-sqlite3',
    );
    expect(persistenceEntry).not.toContain("export * from './runtime/sqlite-database'");
  });
});
