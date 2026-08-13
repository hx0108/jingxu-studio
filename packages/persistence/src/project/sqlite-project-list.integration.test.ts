import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SqliteTestDatabase as Database } from '../testing/sqlite-test-database';
import type { SqliteTestDatabase as TestDatabase } from '../testing/sqlite-test-database';
import { FIXED_TEST_TIME, withSqliteTestContext } from '../testing/sqlite-test-kit';
import { applyMigrations } from '../migrations/migration-runner';
import { loadMigrationSet } from '../migrations/migration-loader';
import { SqliteFormatProfileRepository } from './sqlite-format-profile-repository';
import { SqliteProjectRepository } from './sqlite-project-repository';

const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');
const DEFAULT_SAFE_AREA = JSON.stringify({ top: 5, right: 5, bottom: 12, left: 5 });
// 稳定、可比的 ISO 时间戳（不依赖墙钟），用于 keyset 排序断言。
const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const T3 = '2026-01-03T00:00:00.000Z';
const T4 = '2026-01-04T00:00:00.000Z';

interface ListProjectFixture {
  readonly id: string;
  readonly name?: string;
  readonly updatedAt?: string;
  readonly deletedAt?: string | null;
  readonly aspectRatio?: string;
}

/** 插入一个带 current FormatProfile（v1, is_current=1）的 Project，供 list/scan 查询。 */
const insertListProject = (database: TestDatabase, fixture: ListProjectFixture): void => {
  const aspectRatio = fixture.aspectRatio ?? '9:16';
  database
    .prepare(
      `INSERT INTO projects
       (id, name, genre, style, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fixture.id,
      fixture.name ?? `项目${fixture.id}`,
      null,
      null,
      'AI_ORIGINAL',
      'NARRATION_FIRST',
      'LOCAL_DEMO',
      `projects/${fixture.id}`,
      FIXED_TEST_TIME,
      fixture.updatedAt ?? FIXED_TEST_TIME,
      fixture.deletedAt === undefined ? null : fixture.deletedAt,
    );
  database
    .prepare(
      `INSERT INTO format_profiles
       (id, project_id, version_no, parent_id, aspect_ratio, width, height, fps, language, subtitle_safe_area_json, is_current, created_at)
       VALUES (?, ?, 1, NULL, ?, ?, ?, 30, 'zh-CN', ?, 1, ?)`,
    )
    .run(
      `fp_${fixture.id}`,
      fixture.id,
      aspectRatio,
      aspectRatio === '16:9' ? 1920 : 1080,
      aspectRatio === '16:9' ? 1080 : 1920,
      DEFAULT_SAFE_AREA,
      FIXED_TEST_TIME,
    );
};

const withListDatabase = async <T>(
  operation: (
    database: TestDatabase,
    projects: SqliteProjectRepository,
    profiles: SqliteFormatProfileRepository,
  ) => Promise<T> | T,
): Promise<T> =>
  withSqliteTestContext(async (context) => {
    const database = new Database(path.join(context.root, 'list.sqlite'));
    database.pragma('foreign_keys = ON');
    applyMigrations(database, await loadMigrationSet(MIGRATION_DIRECTORY), context.clock);
    try {
      return await operation(
        database,
        new SqliteProjectRepository(database),
        new SqliteFormatProfileRepository(database),
      );
    } finally {
      database.close();
    }
  });

describe('SQLite Project listPage/scanForSearch keyset 与有界扫描（§5.2）', () => {
  it('稳定 keyset：按 updated_at DESC 排序，无截断', async () => {
    await withListDatabase(async (_db, projects) => {
      insertListProject(_db, { id: 'p1', updatedAt: T1 });
      insertListProject(_db, { id: 'p2', updatedAt: T3 });
      insertListProject(_db, { id: 'p3', updatedAt: T2 });

      const page = await projects.listPage({ scope: 'ACTIVE', limit: 10, after: null });
      expect(page.items.map((i) => i.project.id)).toEqual(['p2', 'p3', 'p1']);
      expect(page.truncated).toBe(false);
      expect(page.nextAfter).toBeNull();
    });
  });

  it('tie-break：同 updated_at 用 id DESC 稳定排序', async () => {
    await withListDatabase(async (_db, projects) => {
      insertListProject(_db, { id: 'p_a', updatedAt: T2 });
      insertListProject(_db, { id: 'p_b', updatedAt: T2 });
      insertListProject(_db, { id: 'p_c', updatedAt: T2 });

      const page = await projects.listPage({ scope: 'ACTIVE', limit: 10, after: null });
      // id 字符串 DESC：p_c > p_b > p_a
      expect(page.items.map((i) => i.project.id)).toEqual(['p_c', 'p_b', 'p_a']);
    });
  });

  it('scope：ACTIVE 与 DELETED 隔离，互不串扰', async () => {
    await withListDatabase(async (_db, projects) => {
      insertListProject(_db, { id: 'p_active', updatedAt: T1 });
      insertListProject(_db, { id: 'p_deleted', updatedAt: T2, deletedAt: T2 });

      const active = await projects.listPage({ scope: 'ACTIVE', limit: 10, after: null });
      const deleted = await projects.listPage({ scope: 'DELETED', limit: 10, after: null });
      expect(active.items.map((i) => i.project.id)).toEqual(['p_active']);
      expect(deleted.items.map((i) => i.project.id)).toEqual(['p_deleted']);
    });
  });

  it('limit 截断 + nextAfter 翻页：4 条 limit=2 分两页取完，第二页无截断', async () => {
    await withListDatabase(async (_db, projects) => {
      insertListProject(_db, { id: 'p1', updatedAt: T1 });
      insertListProject(_db, { id: 'p2', updatedAt: T2 });
      insertListProject(_db, { id: 'p3', updatedAt: T3 });
      insertListProject(_db, { id: 'p4', updatedAt: T4 });

      const page1 = await projects.listPage({ scope: 'ACTIVE', limit: 2, after: null });
      expect(page1.items.map((i) => i.project.id)).toEqual(['p4', 'p3']);
      expect(page1.truncated).toBe(true);
      expect(page1.nextAfter).toEqual({ updatedAt: T3, id: 'p3' });

      if (page1.nextAfter === null) throw new Error('page1 must have nextAfter');
      const page2 = await projects.listPage({
        scope: 'ACTIVE',
        limit: 2,
        after: page1.nextAfter,
      });
      expect(page2.items.map((i) => i.project.id)).toEqual(['p2', 'p1']);
      expect(page2.truncated).toBe(false);
      expect(page2.nextAfter).toBeNull();
    });
  });

  it('currentAspectRatio：JOIN current 版本画幅进列表项', async () => {
    await withListDatabase(async (_db, projects) => {
      insertListProject(_db, { id: 'p169', updatedAt: T1, aspectRatio: '16:9' });
      insertListProject(_db, { id: 'p916', updatedAt: T2, aspectRatio: '9:16' });

      const page = await projects.listPage({ scope: 'ACTIVE', limit: 10, after: null });
      const byId = Object.fromEntries(page.items.map((i) => [i.project.id, i.currentAspectRatio]));
      expect(byId.p169).toBe('16:9');
      expect(byId.p916).toBe('9:16');
    });
  });

  it('scanForSearch：hardLimit 截断标志（达上限 true、未达 false），不做名称过滤', async () => {
    await withListDatabase(async (_db, projects) => {
      insertListProject(_db, { id: 'p1', updatedAt: T1, name: 'alpha' });
      insertListProject(_db, { id: 'p2', updatedAt: T2, name: 'beta' });
      insertListProject(_db, { id: 'p3', updatedAt: T3, name: 'gamma' });

      // hardLimit=2 触及上限：truncated=true，candidates 不含未扫到的 p1
      const scanHit = await projects.scanForSearch({
        scope: 'ACTIVE',
        after: null,
        hardLimit: 2,
      });
      expect(scanHit.candidates.map((c) => c.project.id)).toEqual(['p3', 'p2']);
      expect(scanHit.truncated).toBe(true);

      // hardLimit=3 恰好：全量候选、不过滤名称（alpha/beta/gamma 都在）
      const scanExact = await projects.scanForSearch({
        scope: 'ACTIVE',
        after: null,
        hardLimit: 3,
      });
      expect(scanExact.candidates.map((c) => c.project.id)).toEqual(['p3', 'p2', 'p1']);
      expect(scanExact.truncated).toBe(false);

      // hardLimit 超过实际：truncated=false
      const scanOver = await projects.scanForSearch({
        scope: 'ACTIVE',
        after: null,
        hardLimit: 5,
      });
      expect(scanOver.candidates.map((c) => c.project.id)).toHaveLength(3);
      expect(scanOver.truncated).toBe(false);
    });
  });

  it('scanForSearch after 翻页：keyset 续扫越过已扫描项', async () => {
    await withListDatabase(async (_db, projects) => {
      insertListProject(_db, { id: 'p1', updatedAt: T1 });
      insertListProject(_db, { id: 'p2', updatedAt: T2 });
      insertListProject(_db, { id: 'p3', updatedAt: T3 });

      const first = await projects.scanForSearch({
        scope: 'ACTIVE',
        after: null,
        hardLimit: 2,
      });
      expect(first.candidates.map((c) => c.project.id)).toEqual(['p3', 'p2']);
      const next = await projects.scanForSearch({
        scope: 'ACTIVE',
        after: { updatedAt: T2, id: 'p2' },
        hardLimit: 2,
      });
      expect(next.candidates.map((c) => c.project.id)).toEqual(['p1']);
      expect(next.truncated).toBe(false);
    });
  });
});
