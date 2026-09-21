import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from './migration-loader';
import { applyMigrations } from './migration-runner';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-09-21T00:00:00.000Z';

const openDatabaseAt = async (
  root: string,
  fileName: string,
  versions: number | undefined,
): Promise<SqliteTestDatabase> => {
  const database = new SqliteTestDatabase(path.join(root, fileName));
  try {
    database.pragma('foreign_keys = ON');
    const migrations = await loadMigrationSet(MIGRATIONS);
    applyMigrations(
      database,
      versions === undefined ? migrations : migrations.slice(0, versions),
      () => NOW,
    );
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

const insertProject = (database: SqliteTestDatabase, id: string, name: string): void => {
  database
    .prepare(
      `INSERT INTO projects
       (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, name, 'AI_ORIGINAL', 'NARRATION_FIRST', 'LOCAL_DEMO', `projects/${id}`, NOW, NOW);
};

describe('0026 projects.experience_mode 升级', () => {
  it('空库—全量迁移至 0026—列存在且 STANDARD/DEMO 均可写入', async () => {
    await withSqliteTestContext(async (context) => {
      const database = await openDatabaseAt(context.root, 'empty.db', undefined);
      try {
        const applied = database
          .prepare('SELECT MAX(version) AS version FROM schema_migrations')
          .get() as { readonly version: number };
        expect(applied.version).toBe(26);
        insertProject(database, 'project_standard_01', '常规项目');
        expect(
          database
            .prepare('SELECT COUNT(*) AS count FROM projects WHERE experience_mode = ?')
            .get('STANDARD'),
        ).toMatchObject({ count: 1 });
        database
          .prepare(
            `INSERT INTO projects
             (id, name, creation_mode, dialogue_render_mode, deployment_mode, experience_mode,
              data_root_rel, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'DEMO', ?, ?, ?)`,
          )
          .run(
            'project_demo_0001',
            '演示项目',
            'AI_ORIGINAL',
            'NARRATION_FIRST',
            'LOCAL_DEMO',
            'projects/project_demo_0001',
            NOW,
            NOW,
          );
        const modes = database
          .prepare('SELECT id, experience_mode FROM projects ORDER BY id')
          .all() as unknown as readonly {
          readonly id: string;
          readonly experience_mode: string;
        }[];
        expect(modes).toEqual([
          { id: 'project_demo_0001', experience_mode: 'DEMO' },
          { id: 'project_standard_01', experience_mode: 'STANDARD' },
        ]);
      } finally {
        database.close();
      }
    });
  });

  it('上一版本库（0025）—插入旧行后升级—旧行归位 STANDARD 且新列可用', async () => {
    await withSqliteTestContext(async (context) => {
      const database = await openDatabaseAt(context.root, 'prev.db', 25);
      try {
        insertProject(database, 'project_legacy_01', '升级前项目');
        const migrations = await loadMigrationSet(MIGRATIONS);
        applyMigrations(database, migrations, () => NOW);
        const rows = database
          .prepare('SELECT id, experience_mode FROM projects')
          .all() as unknown as readonly {
          readonly id: string;
          readonly experience_mode: string;
        }[];
        expect(rows).toEqual([{ id: 'project_legacy_01', experience_mode: 'STANDARD' }]);
        database
          .prepare(
            `INSERT INTO projects
             (id, name, creation_mode, dialogue_render_mode, deployment_mode, experience_mode,
              data_root_rel, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'DEMO', ?, ?, ?)`,
          )
          .run(
            'project_demo_0002',
            '演示项目二',
            'AI_ORIGINAL',
            'NARRATION_FIRST',
            'LOCAL_DEMO',
            'projects/project_demo_0002',
            NOW,
            NOW,
          );
        const applied = database
          .prepare('SELECT MAX(version) AS version FROM schema_migrations')
          .get() as { readonly version: number };
        expect(applied.version).toBe(26);
      } finally {
        database.close();
      }
    });
  });

  it('100+ 历史项目库—升级后行数与默认值完整—CHECK 拒绝非法标记', async () => {
    await withSqliteTestContext(async (context) => {
      const database = await openDatabaseAt(context.root, 'bulk.db', 25);
      try {
        const insert = database.prepare(
          `INSERT INTO projects
           (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const total = 120;
        for (let index = 0; index < total; index += 1) {
          const id = `project_bulk_${String(index).padStart(4, '0')}`;
          insert.run(
            id,
            `批量项目${String(index)}`,
            'AI_ORIGINAL',
            'NARRATION_FIRST',
            'LOCAL_DEMO',
            `projects/${id}`,
            NOW,
            NOW,
          );
        }
        const migrations = await loadMigrationSet(MIGRATIONS);
        applyMigrations(database, migrations, () => NOW);
        const counts = database
          .prepare(
            'SELECT experience_mode, COUNT(*) AS total FROM projects GROUP BY experience_mode',
          )
          .all() as unknown as readonly {
          readonly experience_mode: string;
          readonly total: number;
        }[];
        expect(counts).toEqual([{ experience_mode: 'STANDARD', total }]);
        expect(() =>
          database
            .prepare(
              `INSERT INTO projects
               (id, name, creation_mode, dialogue_render_mode, deployment_mode, experience_mode,
                data_root_rel, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'REAL', ?, ?, ?)`,
            )
            .run(
              'project_bad_mode1',
              '坏标记',
              'AI_ORIGINAL',
              'NARRATION_FIRST',
              'LOCAL_DEMO',
              'projects/project_bad_mode1',
              NOW,
              NOW,
            ),
        ).toThrow();
      } finally {
        database.close();
      }
    });
  });
});
