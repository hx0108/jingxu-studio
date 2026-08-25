import { access, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { V1_SCHEMA_LOCKS } from '@jingxu/validation';
import { describe, expect, it } from 'vitest';

import forgeConfig, {
  assertFfmpegResources,
  ffmpegResourceDirectory,
  migrationResourceDirectory,
  schemaResourceDirectory,
} from '../../../forge.config';

describe('Forge SQLite 资源清单', () => {
  it('打包配置—检查 migration 与 SQLite 运行时—包含真实 SQL 且不依赖 native addon', async () => {
    expect(path.basename(migrationResourceDirectory)).toBe('migrations');
    await expect(access(path.join(migrationResourceDirectory, '0001_initial.sql'))).resolves.toBe(
      undefined,
    );
    expect(
      await readFile(path.join(migrationResourceDirectory, '0001_initial.sql'), 'utf8'),
    ).toContain('CREATE TABLE schema_migrations');
    expect(forgeConfig.packagerConfig.extraResource).toEqual([
      migrationResourceDirectory,
      schemaResourceDirectory,
      ffmpegResourceDirectory,
    ]);
    expect(forgeConfig.plugins.map(({ name }) => name)).not.toContain(
      '@electron-forge/plugin-auto-unpack-natives',
    );
    expect(JSON.stringify(forgeConfig)).not.toContain('better-sqlite3');
  });

  it('打包配置—检查 Schema 资源组—固定到 schemas/v1 且恰好匹配四条版本锁', async () => {
    expect(path.basename(schemaResourceDirectory)).toBe('schemas');
    const schemaV1Directory = path.join(schemaResourceDirectory, 'v1');
    const entries = await readdir(schemaV1Directory, { withFileTypes: true });

    expect(entries.every((entry) => entry.isFile() && !entry.isSymbolicLink())).toBe(true);
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      V1_SCHEMA_LOCKS.map((lock) => lock.resourceName).sort(),
    );

    for (const lock of V1_SCHEMA_LOCKS) {
      const bytes = await readFile(path.join(schemaV1Directory, lock.resourceName));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(lock.sha256);
    }
  });

  it('打包配置—检查 FFmpeg 资源组—哈希、许可证和固定版本均可审计', async () => {
    await expect(access(path.join(ffmpegResourceDirectory, 'LICENSE.txt'))).resolves.toBe(
      undefined,
    );
    await expect(access(path.join(ffmpegResourceDirectory, 'NOTICE.txt'))).resolves.toBe(undefined);
    await expect(access(path.join(ffmpegResourceDirectory, 'ffmpeg-manifest.json'))).resolves.toBe(
      undefined,
    );
    expect(() => {
      assertFfmpegResources(ffmpegResourceDirectory);
    }).not.toThrow();
  }, 30_000);
});
