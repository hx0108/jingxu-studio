import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SqlitePersistenceRuntimeAdapter } from '../runtime/persistence-runtime-adapter';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';

const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');

describe('Schema manifest UnitOfWork 生命周期（任务 5.3）', () => {
  it('prepare 成功—复用唯一写连接暴露稳定 UoW—close 后撤销入口', async () => {
    await withSqliteTestContext(async (context) => {
      const adapter = new SqlitePersistenceRuntimeAdapter({
        clock: context.clock,
        managedRoot: path.join(context.root, 'managed'),
        migrationDirectory: MIGRATION_DIRECTORY,
      });

      expect(adapter.getSchemaManifestUnitOfWork()).toBeNull();
      const result = await adapter.prepare();
      expect(result.ok).toBe(true);

      const first = adapter.getSchemaManifestUnitOfWork();
      expect(first).not.toBeNull();
      expect(adapter.getSchemaManifestUnitOfWork()).toBe(first);
      if (first === null) throw new Error('schema manifest UnitOfWork must be available');
      await first.run(async (repository) => {
        await repository.replaceAll([
          {
            enabled: true,
            resourceName: 'script-stage-output.schema.json',
            schemaId: 'https://jingxu.studio/schemas/script-stage-output/1.0.0',
            semanticVersion: '1.0.0',
            sha256: 'a'.repeat(64),
          },
        ]);
      });

      adapter.close();
      expect(adapter.getSchemaManifestUnitOfWork()).toBeNull();
    });
  });

  it('prepare 失败—不暴露 Schema manifest UoW', async () => {
    await withSqliteTestContext(async (context) => {
      const adapter = new SqlitePersistenceRuntimeAdapter({
        clock: context.clock,
        managedRoot: path.join(context.root, 'managed'),
        migrationDirectory: path.join(context.root, 'missing-migrations'),
      });

      const result = await adapter.prepare();

      expect(result.ok).toBe(false);
      expect(adapter.getSchemaManifestUnitOfWork()).toBeNull();
      adapter.close();
    });
  });
});
