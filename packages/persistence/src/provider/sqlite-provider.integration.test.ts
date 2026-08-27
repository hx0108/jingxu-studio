import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ProviderProfile } from '@jingxu/application';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import type {
  SqliteDatabase,
  SqliteOutputValue,
  SqliteStatement,
} from '../runtime/sqlite-database';
import { SqliteTestDatabase as Database } from '../testing/sqlite-test-database';
import { withSqliteTestContext, type SqliteTestContext } from '../testing/sqlite-test-kit';
import { mapProviderProfileRow } from './row-mapper';
import { SqliteProviderUnitOfWork } from './sqlite-provider-unit-of-work';

const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');

const baseProfile = (id = 'provider_test_01'): ProviderProfile => ({
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  config: { dataProcessingHints: ['no-store'], lastValidatedAt: '2026-08-12T00:00:00Z' },
  credentialLast4: '7890',
  credentialRef: 'opaque-ref-001',
  enabled: true,
  id,
  modelId: 'qwen3.7-plus-2026-05-26',
  modelSnapshotDate: '2026-05-26',
  provider: 'QWEN',
  region: 'cn-beijing',
  workspaceId: 'workspace-1',
});

const withProviderDatabase = async <T>(
  context: SqliteTestContext,
  operation: (unitOfWork: SqliteProviderUnitOfWork, database: SqliteDatabase) => Promise<T>,
): Promise<T> => {
  const database = new Database(path.join(context.root, 'provider.sqlite'));
  applyMigrations(database, await loadMigrationSet(MIGRATION_DIRECTORY), context.clock);
  const unitOfWork = new SqliteProviderUnitOfWork(database);
  try {
    return await operation(unitOfWork, database);
  } finally {
    database.close();
  }
};

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

const CONFIG_JSON = JSON.stringify({
  credentialLast4: '7890',
  dataProcessingHints: ['no-store'],
  lastValidatedAt: '2026-08-12T00:00:00Z',
});

const validRow = (): Record<string, SqliteOutputValue> => ({
  base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  config_json: CONFIG_JSON,
  credential_ref: 'opaque-ref-001',
  enabled: 1,
  id: 'provider_test_01',
  model_id: 'qwen3.7-plus-2026-05-26',
  model_snapshot_date: '2026-05-26',
  provider: 'QWEN',
  region: 'cn-beijing',
  workspace_id: 'workspace-1',
});

describe('provider_profiles Repository 与 UnitOfWork（任务 6.4）', () => {
  it('空表返回 null；落行后按显式列读取，config 与末四位稳定往返', async () => {
    await withSqliteTestContext(async (context) => {
      await withProviderDatabase(context, async (unitOfWork) => {
        await expect(unitOfWork.run((r) => r.profiles.findById('provider_test_01'))).resolves.toBe(
          null,
        );

        const profile = baseProfile();
        await unitOfWork.run(async (r) => {
          await r.profiles.save(profile);
        });

        const read = await unitOfWork.run((r) => r.profiles.findById('provider_test_01'));
        expect(read).toEqual(profile);
        expect(read?.config).toEqual({
          dataProcessingHints: ['no-store'],
          lastValidatedAt: '2026-08-12T00:00:00Z',
        });
        expect(read?.credentialLast4).toBe('7890');
      });
    });
  });

  it('Seedance 视频 Profile—按合法 Provider 枚举读取，不误判为损坏行', () => {
    const row = validRow();
    row.provider = 'VOLCARK_SEEDANCE';
    row.model_id = 'doubao-seedance-2-0-260128';
    row.model_snapshot_date = '2026-01-28';
    row.workspace_id = 'ark';

    expect(mapProviderProfileRow(row)).toMatchObject({
      modelId: 'doubao-seedance-2-0-260128',
      provider: 'VOLCARK_SEEDANCE',
    });
  });

  it('QWEN_TTS 配音 Profile—按合法 Provider 枚举读取，不误判为损坏行', () => {
    const row = validRow();
    row.provider = 'QWEN_TTS';
    row.model_id = 'qwen3-tts-instruct-flash';
    row.model_snapshot_date = '2026-01-26';
    row.workspace_id = 'dashscope';

    expect(mapProviderProfileRow(row)).toMatchObject({
      modelId: 'qwen3-tts-instruct-flash',
      provider: 'QWEN_TTS',
    });
  });

  it('upsert：再次 save 更新启用状态、工作区与 config，不产生第二行', async () => {
    await withSqliteTestContext(async (context) => {
      await withProviderDatabase(context, async (unitOfWork, database) => {
        await unitOfWork.run(async (r) => {
          await r.profiles.save(baseProfile());
        });
        const updated: ProviderProfile = {
          ...baseProfile(),
          config: { dataProcessingHints: [], lastValidatedAt: null },
          credentialLast4: '1234',
          credentialRef: 'opaque-ref-002',
          enabled: false,
          workspaceId: 'workspace-2',
        };
        await unitOfWork.run(async (r) => {
          await r.profiles.save(updated);
        });

        const read = await unitOfWork.run((r) => r.profiles.findById('provider_test_01'));
        expect(read).toEqual(updated);
        expect(read?.enabled).toBe(false);
        const count = database.prepare('SELECT COUNT(*) AS n FROM provider_profiles').get() as {
          n: number;
        };
        expect(count.n).toBe(1);
      });
    });
  });

  it('delete 删除整行并写审计；审计行落在同一事务', async () => {
    await withSqliteTestContext(async (context) => {
      await withProviderDatabase(context, async (unitOfWork, database) => {
        await unitOfWork.run(async (r) => {
          await r.profiles.save(baseProfile());
        });

        await unitOfWork.run(async (r) => {
          await r.profiles.delete('provider_test_01');
          await r.audit.recordCredentialDeleted('provider_test_01', '2026-08-12T00:00:00Z');
        });

        await expect(unitOfWork.run((r) => r.profiles.findById('provider_test_01'))).resolves.toBe(
          null,
        );
        const audit = database
          .prepare(
            "SELECT actor, action, object_type, trace_id, created_at FROM audit_events WHERE object_id = 'provider_test_01'",
          )
          .get() as {
          actor: string;
          action: string;
          object_type: string;
          trace_id: string;
          created_at: string;
        };
        expect(audit).toMatchObject({
          actor: 'SYSTEM',
          action: 'PROVIDER_CREDENTIAL_DELETED',
          object_type: 'provider_profile',
          trace_id: 'system-provider-audit',
          created_at: '2026-08-12T00:00:00Z',
        });
      });
    });
  });

  it('UnitOfWork 回滚：work 抛错时此前的 delete 不生效', async () => {
    await withSqliteTestContext(async (context) => {
      await withProviderDatabase(context, async (unitOfWork) => {
        await unitOfWork.run(async (r) => {
          await r.profiles.save(baseProfile());
        });

        await expect(
          unitOfWork.run(async (r) => {
            await r.profiles.delete('provider_test_01');
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');

        const read = await unitOfWork.run((r) => r.profiles.findById('provider_test_01'));
        expect(read?.id).toBe('provider_test_01');
      });
    });
  });

  it('save 拒绝空 credentialRef（DB NOT NULL 之上的应用守卫）', async () => {
    await withSqliteTestContext(async (context) => {
      await withProviderDatabase(context, async (unitOfWork) => {
        const withoutRef: ProviderProfile = { ...baseProfile(), credentialRef: null };
        await expect(
          unitOfWork.run(async (r) => {
            await r.profiles.save(withoutRef);
          }),
        ).rejects.toThrow(PersistenceRuntimeError);
      });
    });
  });

  it('坏 provider/region/base_url/enabled/config_json Row 归一化为 PersistenceRuntimeError', () => {
    const cases: { name: string; row: Record<string, SqliteOutputValue> }[] = [
      { name: 'provider', row: { ...validRow(), provider: 'OPENAI' } },
      { name: 'region', row: { ...validRow(), region: 'us-east-1' } },
      { name: 'base_url', row: { ...validRow(), base_url: 'http://insecure' } },
      { name: 'enabled', row: { ...validRow(), enabled: 7 } },
      { name: 'config_json', row: { ...validRow(), config_json: '{not json' } },
      {
        name: 'hints',
        row: { ...validRow(), config_json: JSON.stringify({ dataProcessingHints: 'nope' }) },
      },
    ];
    for (const { name, row } of cases) {
      expect(() => mapProviderProfileRow(row), `bad ${name}`).toThrow(PersistenceRuntimeError);
    }
  });

  it('生产 SQL 使用显式列且全部值经参数绑定', async () => {
    await withSqliteTestContext(async (context) => {
      await withProviderDatabase(context, async (_, database) => {
        const trace: SqlTrace = { prepared: [], parameters: [] };
        const unitOfWork = new SqliteProviderUnitOfWork(traceDatabase(database, trace));
        await unitOfWork.run(async (r) => {
          await r.profiles.save(baseProfile());
          await r.profiles.findById('provider_test_01');
        });

        expect(trace.prepared.some((sql) => /SELECT\s+\*/iu.test(sql))).toBe(false);
        const insertSql = trace.prepared.find((sql) => sql.trimStart().startsWith('INSERT'));
        expect(insertSql).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        expect(trace.prepared.join('\n')).not.toContain('opaque-ref-001');
        expect(trace.parameters.some((parameters) => parameters[8] === 'opaque-ref-001')).toBe(
          true,
        );
      });
    });
  });
});
