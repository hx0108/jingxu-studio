import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import type { SqliteDatabase, SqliteStatement } from '../runtime/sqlite-database';
import { SqliteTestDatabase as Database } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { mapSchemaManifestRow } from './row-mapper';
import { SqliteSchemaManifestUnitOfWork } from './sqlite-schema-manifest-unit-of-work';

const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');

const CURRENT_MANIFEST = [
  {
    schemaId: 'https://jingxu.studio/schemas/script-stage-output/1.0.0',
    semanticVersion: '1.0.0',
    resourceName: 'ScriptStageOutput.schema.json',
    sha256: '128e7a49e1d5829c4b0c9cf89fc5e6fd883746f022e9759c157f70176309971f',
    enabled: true,
  },
  {
    schemaId: 'https://jingxu.studio/schemas/shot-contract/1.1.0',
    semanticVersion: '1.1.0',
    resourceName: 'shot-contract.schema.json',
    sha256: '3fa77aa85152ad2500fcc1c07da5bec697da8810c572d1c378b0bf432f437e4b',
    enabled: true,
  },
  {
    schemaId: 'https://jingxu.studio/schemas/episode-storyboard-export/1.1.0',
    semanticVersion: '1.1.0',
    resourceName: 'episode-storyboard-export.schema.json',
    sha256: '55238d1958aae25341d137192cf544946b9d8b8767648a98a3956e01798fcb13',
    enabled: true,
  },
  {
    schemaId: 'https://jingxu.studio/schemas/project-transfer-bundle/1.0.0',
    semanticVersion: '1.0.0',
    resourceName: 'project-transfer-bundle.schema.json',
    sha256: '9736ee2421fa8b8febe683c6e41e3cae47665df5d7afe85592a25e4fa4fbabbb',
    enabled: true,
  },
] as const;

const OLD_MANIFEST = CURRENT_MANIFEST.map((record, index) => ({
  ...record,
  schemaId: `${record.schemaId}-old`,
  semanticVersion: '0.9.0',
  resourceName: `old-${String(index + 1)}.schema.json`,
  sha256: String(index + 1).repeat(64),
}));

const bySchemaId = <T extends Readonly<{ schemaId: string }>>(
  records: readonly T[],
): readonly T[] => [...records].sort((left, right) => left.schemaId.localeCompare(right.schemaId));

const withManifestDatabase = async <T>(
  operation: (database: SqliteDatabase) => Promise<T>,
): Promise<T> =>
  withSqliteTestContext(async (context) => {
    const database = new Database(path.join(context.root, 'schema-manifest.sqlite'));
    applyMigrations(database, await loadMigrationSet(MIGRATION_DIRECTORY), context.clock);
    try {
      return await operation(database);
    } finally {
      database.close();
    }
  });

interface SqlTrace {
  readonly prepared: string[];
  readonly parameters: unknown[][];
}

const traceDatabase = (database: SqliteDatabase, trace: SqlTrace): SqliteDatabase => ({
  close: database.close,
  exec: (sql) => {
    database.exec(sql);
  },
  prepare: (sql): SqliteStatement => {
    trace.prepared.push(sql);
    const statement = database.prepare(sql);
    return {
      all: (...parameters) => {
        trace.parameters.push(parameters);
        return statement.all(...parameters);
      },
      get: (...parameters) => {
        trace.parameters.push(parameters);
        return statement.get(...parameters);
      },
      run: (...parameters) => {
        trace.parameters.push(parameters);
        return statement.run(...parameters);
      },
    };
  },
});

type FailurePoint = 'DELETE' | `INSERT_${1 | 2 | 3 | 4}` | 'READBACK';

const failDatabaseAt = (database: SqliteDatabase, failurePoint: FailurePoint): SqliteDatabase => {
  let insertCount = 0;
  return {
    close: database.close,
    exec: (sql) => {
      database.exec(sql);
    },
    prepare: (sql): SqliteStatement => {
      const normalized = sql.trimStart().toUpperCase();
      if (failurePoint === 'DELETE' && normalized.startsWith('DELETE')) {
        throw new Error('injected delete failure');
      }
      if (failurePoint === 'READBACK' && normalized.startsWith('SELECT')) {
        throw new Error('injected readback failure');
      }
      const statement = database.prepare(sql);
      return {
        all: (...parameters) => statement.all(...parameters),
        get: (...parameters) => statement.get(...parameters),
        run: (...parameters) => {
          if (normalized.startsWith('INSERT')) {
            insertCount += 1;
            const currentFailurePoint = `INSERT_${String(insertCount)}`;
            if (failurePoint === currentFailurePoint) {
              throw new Error(`injected insert ${String(insertCount)} failure`);
            }
          }
          return statement.run(...parameters);
        },
      };
    },
  };
};

describe('schema_registry_manifest Repository（任务 5.1）', () => {
  it('空表返回空集合，写入四条后只读取启用记录并映射稳定字段', async () => {
    await withManifestDatabase(async (database) => {
      const unitOfWork = new SqliteSchemaManifestUnitOfWork(database);
      await expect(unitOfWork.run((repository) => repository.findEnabled())).resolves.toEqual([]);

      const records = await unitOfWork.run(async (repository) => {
        await repository.replaceAll(CURRENT_MANIFEST);
        return repository.findEnabled();
      });

      expect(records).toEqual(bySchemaId(CURRENT_MANIFEST));
      expect(Object.keys(records[0] ?? {}).sort()).toEqual(
        ['enabled', 'resourceName', 'schemaId', 'semanticVersion', 'sha256'].sort(),
      );
    });
  });

  it('坏 hash、版本和 enabled Row 均归一化为 PersistenceRuntimeError', () => {
    const base = {
      schema_id: CURRENT_MANIFEST[0].schemaId,
      semantic_version: CURRENT_MANIFEST[0].semanticVersion,
      resource_path: CURRENT_MANIFEST[0].resourceName,
      sha256: CURRENT_MANIFEST[0].sha256,
      enabled: 1,
    };

    expect(() => mapSchemaManifestRow({ ...base, sha256: 'A'.repeat(64) })).toThrow(
      PersistenceRuntimeError,
    );
    expect(() => mapSchemaManifestRow({ ...base, semantic_version: 'version-one' })).toThrow(
      PersistenceRuntimeError,
    );
    expect(() => mapSchemaManifestRow({ ...base, enabled: 7 })).toThrow(PersistenceRuntimeError);
  });

  it('生产 SQL 显式列字段且所有 manifest 值均通过参数绑定', async () => {
    await withManifestDatabase(async (database) => {
      const trace: SqlTrace = { prepared: [], parameters: [] };
      const unitOfWork = new SqliteSchemaManifestUnitOfWork(traceDatabase(database, trace));
      await unitOfWork.run(async (repository) => {
        await repository.replaceAll(CURRENT_MANIFEST);
        await repository.findEnabled();
      });

      expect(trace.prepared.some((sql) => /SELECT\s+\*/iu.test(sql))).toBe(false);
      const insertSql = trace.prepared.find((sql) => sql.trimStart().startsWith('INSERT'));
      expect(insertSql).toBeDefined();
      expect(insertSql).toContain('VALUES (?, ?, ?, ?, ?)');
      expect(trace.prepared.join('\n')).not.toContain(CURRENT_MANIFEST[0].schemaId);
      expect(
        trace.parameters.some((parameters) => parameters[0] === CURRENT_MANIFEST[0].schemaId),
      ).toBe(true);
    });
  });
});

describe('schema_registry_manifest 原子替换（任务 5.2）', () => {
  it('空表写入四条，并把旧集合及额外或缺失记录精确替换为当前四条', async () => {
    await withManifestDatabase(async (database) => {
      const unitOfWork = new SqliteSchemaManifestUnitOfWork(database);
      await unitOfWork.run((repository) => repository.replaceAll(CURRENT_MANIFEST));
      await expect(unitOfWork.run((repository) => repository.findEnabled())).resolves.toEqual(
        bySchemaId(CURRENT_MANIFEST),
      );

      await unitOfWork.run((repository) => repository.replaceAll(OLD_MANIFEST));
      await unitOfWork.run(async (repository) => {
        await repository.replaceAll(CURRENT_MANIFEST.slice(0, 3));
        await repository.replaceAll(CURRENT_MANIFEST);
      });
      await expect(unitOfWork.run((repository) => repository.findEnabled())).resolves.toEqual(
        bySchemaId(CURRENT_MANIFEST),
      );
    });
  });

  it.each<FailurePoint>(['DELETE', 'INSERT_1', 'INSERT_2', 'INSERT_3', 'INSERT_4', 'READBACK'])(
    '%s 故障会回滚并完整保留旧集合，不留下部分新证据',
    async (failurePoint) => {
      await withManifestDatabase(async (database) => {
        const seed = new SqliteSchemaManifestUnitOfWork(database);
        await seed.run((repository) => repository.replaceAll(OLD_MANIFEST));

        const failing = new SqliteSchemaManifestUnitOfWork(failDatabaseAt(database, failurePoint));
        await expect(
          failing.run(async (repository) => {
            await repository.replaceAll(CURRENT_MANIFEST);
            return repository.findEnabled();
          }),
        ).rejects.toThrow('injected');

        await expect(seed.run((repository) => repository.findEnabled())).resolves.toEqual(
          bySchemaId(OLD_MANIFEST),
        );
      });
    },
  );
});
