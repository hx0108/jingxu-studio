import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteTestDatabase as Database } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { runDatabaseAudit } from './database-audit';

const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');

describe('数据库启动 audit', () => {
  it('完整初始库—执行审计—确定性检查 PASS 且后续能力明确未实现', async () => {
    await withSqliteTestContext(async (context) => {
      const database = new Database(path.join(context.root, 'audit.sqlite'));
      database.pragma('foreign_keys = ON');
      applyMigrations(database, await loadMigrationSet(MIGRATION_DIRECTORY), context.clock);

      const result = runDatabaseAudit(database);

      expect(result.ok).toBe(true);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: 'sqlite.integrity', status: 'PASS' }),
          expect.objectContaining({ ruleId: 'sqlite.foreign-keys', status: 'PASS' }),
          expect.objectContaining({
            ruleId: 'contract.document-schema',
            status: 'NOT_IMPLEMENTED_BY_CURRENT_BUILD',
          }),
        ]),
      );
      database.close();
    });
  });

  it('外键和 current pointer 违规—执行审计—返回 FAIL', async () => {
    await withSqliteTestContext(async (context) => {
      const database = new Database(path.join(context.root, 'invalid.sqlite'));
      applyMigrations(database, await loadMigrationSet(MIGRATION_DIRECTORY), context.clock);
      database.pragma('foreign_keys = OFF');
      database
        .prepare(
          `INSERT INTO episodes
           (id, project_id, title, target_duration_sec, current_version_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'episode_1',
          'project_1',
          '第一集',
          90,
          'missing_episode_version',
          context.clock(),
          context.clock(),
        );
      database
        .prepare(
          `INSERT INTO projects
           (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'project_1',
          '项目',
          'AI_ORIGINAL',
          'NARRATION_FIRST',
          'LOCAL_DEMO',
          'projects/1',
          context.clock(),
          context.clock(),
        );
      database
        .prepare(
          'INSERT INTO shots (id, episode_id, lifecycle_status, current_version_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          'shot_1',
          'missing_episode',
          'ACTIVE',
          'missing_version',
          context.clock(),
          context.clock(),
        );
      database.pragma('foreign_keys = ON');

      const result = runDatabaseAudit(database);

      expect(result.ok).toBe(false);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: 'sqlite.foreign-keys', status: 'FAIL' }),
          expect.objectContaining({ ruleId: 'shots.current-version-owner', status: 'FAIL' }),
          expect.objectContaining({ ruleId: 'episodes.current-version-owner', status: 'FAIL' }),
        ]),
      );
      database.close();
    });
  });

  it('integrity_check 返回异常—执行审计—关闭通过结果', async () => {
    await withSqliteTestContext((context) => {
      const database = new Database(path.join(context.root, 'integrity.sqlite'));

      const result = runDatabaseAudit(database, { integrityRows: ['page 1 damaged'] });

      expect(result.ok).toBe(false);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: 'sqlite.integrity', status: 'FAIL' }),
        ]),
      );
      database.close();
    });
  });
});
