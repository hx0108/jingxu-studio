import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import forgeConfig, { migrationResourceDirectory } from '../../../forge.config';

describe('Forge SQLite 资源清单', () => {
  it('打包配置—检查 migration 与 SQLite 运行时—包含真实 SQL 且不依赖 native addon', async () => {
    expect(path.basename(migrationResourceDirectory)).toBe('migrations');
    await expect(access(path.join(migrationResourceDirectory, '0001_initial.sql'))).resolves.toBe(
      undefined,
    );
    expect(
      await readFile(path.join(migrationResourceDirectory, '0001_initial.sql'), 'utf8'),
    ).toContain('CREATE TABLE schema_migrations');
    expect(forgeConfig.packagerConfig.extraResource).toBe(migrationResourceDirectory);
    expect(forgeConfig.plugins.map(({ name }) => name)).not.toContain(
      '@electron-forge/plugin-auto-unpack-natives',
    );
    expect(JSON.stringify(forgeConfig)).not.toContain('better-sqlite3');
  });
});
