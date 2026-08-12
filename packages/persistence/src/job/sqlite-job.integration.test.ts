import path from 'node:path';

import type { ScriptStageJob } from '@jingxu/application';
import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import type { SqliteDatabase, SqliteStatement } from '../runtime/sqlite-database';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { SqliteJobUnitOfWork } from './sqlite-job-unit-of-work';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-12T00:00:00.000Z';

const withDatabase = async <T>(operation: (database: SqliteTestDatabase) => Promise<T>) =>
  withSqliteTestContext(async ({ root }) => {
    const database = new SqliteTestDatabase(path.join(root, 'jobs.sqlite'));
    try {
      applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
      seedReferences(database);
      return await operation(database);
    } finally {
      database.close();
    }
  });

const seedReferences = (database: SqliteDatabase): void => {
  database
    .prepare(
      `INSERT INTO projects
    (id,name,creation_mode,dialogue_render_mode,deployment_mode,data_root_rel,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run('p1', '项目', 'AI_ORIGINAL', 'NARRATION_FIRST', 'LOCAL_DEMO', 'projects/p1', NOW, NOW);
  database
    .prepare(
      `INSERT INTO prompt_templates
    (id,stage,version,template_text,sha256,active,created_at) VALUES (?,?,?,?,?,?,?)`,
    )
    .run('prompt1', 'CONCEPT', 1, 't', 'sha', 1, NOW);
};

const job = (id: string, idempotencyKey = id): ScriptStageJob => ({
  id,
  projectId: 'p1',
  episodeId: null,
  stage: 'CONCEPT',
  operationType: 'GENERATE',
  status: 'QUEUED',
  idempotencyKey,
  userOperationId: `op-${id}`,
  inputVersionsJson: '[]',
  inputVersionSetHash: 'inputs',
  selectionJson: null,
  writeSetJson: '[]',
  lockSnapshotHash: 'locks',
  promptTemplateId: 'prompt1',
  transportAttempts: 0,
  structureRepairAttempts: 0,
  leaseToken: null,
  leaseExpiresAt: null,
  deadlineAt: null,
  cancelRequestedAt: null,
  errorCode: null,
  errorJson: null,
  queuedAt: NOW,
  startedAt: null,
  finishedAt: null,
  createdAt: NOW,
});

describe('script_stage_jobs Repository', () => {
  it('空表—读取与有界状态列表—返回空且不泄漏数据库对象', async () => {
    await withDatabase(async (database) => {
      const uow = new SqliteJobUnitOfWork(database);
      await expect(uow.run(({ jobs }) => jobs.findById('missing'))).resolves.toBeNull();
      await expect(uow.run(({ jobs }) => jobs.listByStatuses(['QUEUED'], 10))).resolves.toEqual([]);
    });
  });

  it('两个领取方—同一 QUEUED Job 条件更新—仅首个命中', async () => {
    await withDatabase(async (database) => {
      const uow = new SqliteJobUnitOfWork(database);
      await uow.run(({ jobs }) => jobs.insert(job('j1')));
      const command = { jobId: 'j1', leaseExpiresAt: NOW, startedAt: NOW, deadlineAt: NOW };
      await expect(
        uow.run(({ jobs }) => jobs.claimQueued({ ...command, leaseToken: 'lease-a' })),
      ).resolves.toBe(true);
      await expect(
        uow.run(({ jobs }) => jobs.claimQueued({ ...command, leaseToken: 'lease-b' })),
      ).resolves.toBe(false);
      const claimed = await uow.run(({ jobs }) => jobs.findById('j1'));
      expect(claimed).toMatchObject({ status: 'RUNNING', leaseToken: 'lease-a' });
    });
  });

  it('同项目幂等键冲突—第二次插入—归一化而非泄漏 SQLite 原错', async () => {
    await withDatabase(async (database) => {
      const uow = new SqliteJobUnitOfWork(database);
      await uow.run(({ jobs }) => jobs.insert(job('j1', 'same')));
      await expect(uow.run(({ jobs }) => jobs.insert(job('j2', 'same')))).rejects.toMatchObject({
        code: 'JOB_IDEMPOTENCY_CONFLICT',
      });
    });
  });

  it.each([
    ['status', 'BROKEN'],
    ['transport_attempts', 9],
    ['structure_repair_attempts', 9],
  ] as const)('坏 %s Row—读取—归一化为 JOB_ROW_CORRUPT', async (column, value) => {
    await withDatabase(async (database) => {
      const uow = new SqliteJobUnitOfWork(database);
      await uow.run(({ jobs }) => jobs.insert(job('j1')));
      const corrupting = new Proxy(database, {
        get(target, property) {
          if (property !== 'prepare') {
            const value = target[property as keyof SqliteDatabase];
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (sql: string): SqliteStatement => {
            const statement = target.prepare(sql);
            if (!sql.startsWith('SELECT') || !sql.includes('script_stage_jobs')) return statement;
            return {
              ...statement,
              get: (...params) => {
                const row = statement.get(...params);
                return row === undefined ? undefined : { ...row, [column]: value };
              },
            };
          };
        },
      }) as SqliteDatabase;
      await expect(
        new SqliteJobUnitOfWork(corrupting).run(({ jobs }) => jobs.findById('j1')),
      ).rejects.toEqual(new PersistenceRuntimeError('JOB_ROW_CORRUPT'));
    });
  });

  it('Repository SQL—执行读写—使用参数绑定且无 SELECT *', async () => {
    await withDatabase(async (database) => {
      const sql: string[] = [];
      const traced = new Proxy(database, {
        get(target, property) {
          if (property !== 'prepare') {
            const value = target[property as keyof SqliteDatabase];
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (statement: string) => {
            sql.push(statement);
            return target.prepare(statement);
          };
        },
      }) as SqliteDatabase;
      const uow = new SqliteJobUnitOfWork(traced);
      await uow.run(async ({ jobs }) => {
        await jobs.insert(job('j1'));
        await jobs.findById('j1');
      });
      expect(sql.join('\n')).not.toMatch(/SELECT\s+\*/iu);
      expect(sql.join('\n')).toContain('?');
    });
  });
});
