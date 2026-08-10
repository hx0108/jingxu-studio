import { createHash } from 'node:crypto';
import path from 'node:path';

import { createProjectService, createStableHasher } from '@jingxu/application';
import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import type { SqliteDatabase, SqliteStatement } from '../runtime/sqlite-database';
import { SqliteTestDatabase as Database } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { SqliteProjectUnitOfWork } from './sqlite-project-unit-of-work';

const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');

interface SqlMeter {
  readonly sql: string[];
  statementExecutions: number;
  transactionDepth: number;
}

const meterDatabase = (database: SqliteDatabase, meter: SqlMeter): SqliteDatabase => ({
  close: database.close,
  exec: (sql) => {
    meter.sql.push(sql);
    if (sql === 'BEGIN IMMEDIATE') meter.transactionDepth += 1;
    database.exec(sql);
    if (sql === 'COMMIT' || sql === 'ROLLBACK') meter.transactionDepth -= 1;
  },
  prepare: (sql): SqliteStatement => {
    meter.sql.push(sql);
    const statement = database.prepare(sql);
    return {
      all: (...parameters) => {
        meter.statementExecutions += 1;
        return statement.all(...parameters);
      },
      get: (...parameters) => {
        meter.statementExecutions += 1;
        return statement.get(...parameters);
      },
      run: (...parameters) => {
        meter.statementExecutions += 1;
        return statement.run(...parameters);
      },
    };
  },
});

describe('Project SQL/目录确定性预算（§9.5）', () => {
  it('create/update/list—执行语句有界、目录不进入事务、列表保持 keyset+limit', async () => {
    await withSqliteTestContext(async (context) => {
      const database = new Database(path.join(context.root, 'statement-budget.sqlite'));
      applyMigrations(database, await loadMigrationSet(MIGRATION_DIRECTORY), context.clock);
      const meter: SqlMeter = { sql: [], statementExecutions: 0, transactionDepth: 0 };
      const unitOfWork = new SqliteProjectUnitOfWork(meterDatabase(database, meter));
      let directoryPrepareCount = 0;
      let directoryCallInsideTransaction = 0;
      let idSequence = 0;
      const service = createProjectService({
        clock: { now: () => Date.parse('2026-08-10T00:00:00.000Z') },
        directory: {
          cleanupIfCreatedEmpty: () => Promise.resolve({ deleted: true }),
          prepare: (projectId) => {
            directoryPrepareCount += 1;
            if (meter.transactionDepth !== 0) directoryCallInsideTransaction += 1;
            return Promise.resolve({ projectId, created: true });
          },
        },
        hasher: createStableHasher((input) => createHash('sha256').update(input).digest('hex')),
        idGenerator: { newId: () => `entity_${String(++idSequence).padStart(12, '0')}` },
        unitOfWork,
      });

      const beforeCreate = meter.statementExecutions;
      const created = await service.create(
        {
          requestId: 'statement_create_0001',
          name: '语句预算项目',
          genre: null,
          style: null,
          creationMode: 'AI_ORIGINAL',
          dialogueRenderMode: 'NARRATION_FIRST',
          aspectRatio: '9:16',
          subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
        },
        'statement_trace_create',
      );
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error('statement fixture create failed');
      const createStatements = meter.statementExecutions - beforeCreate;

      const beforeUpdate = meter.statementExecutions;
      const updated = await service.update(
        {
          requestId: 'statement_update_0001',
          projectId: created.data.id,
          expectedUpdatedAt: created.data.updatedAt,
          name: created.data.name,
          genre: '测试',
          style: null,
          dialogueRenderMode: created.data.dialogueRenderMode,
          aspectRatio: '16:9',
          subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
        },
        'statement_trace_update',
      );
      expect(updated.ok).toBe(true);
      const updateStatements = meter.statementExecutions - beforeUpdate;

      const listed = await service.list(
        { scope: 'ACTIVE', limit: 1, cursor: null, search: null },
        'statement_trace_list',
      );
      expect(listed.ok).toBe(true);
      expect(directoryPrepareCount).toBe(1);
      expect(directoryCallInsideTransaction).toBe(0);
      expect(meter.transactionDepth).toBe(0);
      const listSql = meter.sql.find((sql) => sql.includes('ORDER BY p.updated_at DESC'));
      database.close();
      process.stdout.write(
        `JINGXU_PROJECT_STATEMENT_BUDGET ${JSON.stringify({ createStatements, updateStatements })}\n`,
      );
      expect(createStatements).toBeLessThanOrEqual(10);
      expect(updateStatements).toBeLessThanOrEqual(13);
      expect(listSql).toContain('LIMIT ?');
      expect(listSql).not.toContain('OFFSET');
    });
  });
});
