import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SqliteTestDatabase as Database } from '../testing/sqlite-test-database';
import type { SqliteTestDatabase as TestDatabase } from '../testing/sqlite-test-database';
import { FIXED_TEST_TIME, withSqliteTestContext } from '../testing/sqlite-test-kit';
import { applyMigrations } from '../migrations/migration-runner';
import { loadMigrationSet } from '../migrations/migration-loader';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import type { Row } from './row-mapper';
import { mapFormatProfileRow } from './row-mapper';
import { SqliteFormatProfileRepository } from './sqlite-format-profile-repository';
import { SqliteProjectRepository } from './sqlite-project-repository';

const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');
const DEFAULT_SAFE_AREA = JSON.stringify({ top: 5, right: 5, bottom: 12, left: 5 });

interface ProjectFixture {
  readonly id: string;
  readonly name?: string;
  readonly genre?: string | null;
  readonly style?: string | null;
  readonly deletedAt?: string | null;
  readonly updatedAt?: string;
}

const insertProject = (database: TestDatabase, fixture: ProjectFixture): void => {
  database
    .prepare(
      `INSERT INTO projects
       (id, name, genre, style, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fixture.id,
      fixture.name ?? '测试项目',
      fixture.genre === undefined ? null : fixture.genre,
      fixture.style === undefined ? null : fixture.style,
      'AI_ORIGINAL',
      'NARRATION_FIRST',
      'LOCAL_DEMO',
      `projects/${fixture.id}`,
      FIXED_TEST_TIME,
      fixture.updatedAt ?? FIXED_TEST_TIME,
      fixture.deletedAt === undefined ? null : fixture.deletedAt,
    );
};

interface FormatProfileFixture {
  readonly id: string;
  readonly projectId: string;
  readonly versionNo: number;
  readonly parentId?: string | null;
  readonly aspectRatio?: string;
  readonly width?: number;
  readonly height?: number;
  readonly subtitleSafeAreaJson?: string;
  readonly isCurrent?: number;
}

const insertFormatProfile = (database: TestDatabase, fixture: FormatProfileFixture): void => {
  database
    .prepare(
      `INSERT INTO format_profiles
       (id, project_id, version_no, parent_id, aspect_ratio, width, height, fps, language, subtitle_safe_area_json, is_current, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fixture.id,
      fixture.projectId,
      fixture.versionNo,
      fixture.parentId === undefined ? null : fixture.parentId,
      fixture.aspectRatio ?? '9:16',
      fixture.width ?? 1080,
      fixture.height ?? 1920,
      30,
      'zh-CN',
      fixture.subtitleSafeAreaJson ?? DEFAULT_SAFE_AREA,
      fixture.isCurrent ?? 0,
      FIXED_TEST_TIME,
    );
};

const withProjectDatabase = async <T>(
  operation: (
    database: TestDatabase,
    projects: SqliteProjectRepository,
    profiles: SqliteFormatProfileRepository,
  ) => Promise<T> | T,
): Promise<T> =>
  withSqliteTestContext(async (context) => {
    const database = new Database(path.join(context.root, 'project.sqlite'));
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

describe('SQLite Project/FormatProfile Row mapper 与基础读（§5.1）', () => {
  it('Project：genre/style 为 null 与有值都正确映射，data_root_rel 不泄漏进聚合', async () => {
    await withProjectDatabase(async (_db, projects) => {
      insertProject(_db, { id: 'p_full', name: '全字段', genre: '热血', style: '赛博' });
      insertProject(_db, { id: 'p_null', name: '空字段', genre: null, style: null });

      const full = await projects.findById('p_full', 'ACTIVE');
      const nullable = await projects.findById('p_null', 'ACTIVE');

      expect(full).not.toBeNull();
      expect(nullable).not.toBeNull();
      if (full === null || nullable === null) {
        throw new Error('seed projects must resolve');
      }
      expect(full.genre).toBe('热血');
      expect(full.style).toBe('赛博');
      expect(nullable.genre).toBeNull();
      expect(nullable.style).toBeNull();
      // data_root_rel 属持久化细节，绝不进入领域聚合
      const fullRecord = full as unknown as Record<string, unknown>;
      expect(fullRecord.dataRootRel).toBeUndefined();
      expect(fullRecord.data_root_rel).toBeUndefined();
    });
  });

  it('findById：ACTIVE 只查未删除、DELETED 只查已软删除', async () => {
    await withProjectDatabase(async (_db, projects) => {
      insertProject(_db, { id: 'p_active', name: '活动' });
      insertProject(_db, { id: 'p_deleted', name: '已删', deletedAt: FIXED_TEST_TIME });

      expect((await projects.findById('p_active', 'ACTIVE'))?.name).toBe('活动');
      expect(await projects.findById('p_deleted', 'ACTIVE')).toBeNull();
      expect((await projects.findById('p_deleted', 'DELETED'))?.deletedAt).toBe(FIXED_TEST_TIME);
      expect(await projects.findById('p_active', 'DELETED')).toBeNull();
    });
  });

  it('findActiveNameRefs：返回活动项目 id+name，排除指定 id，不含已删除', async () => {
    await withProjectDatabase(async (_db, projects) => {
      insertProject(_db, { id: 'p1', name: '一' });
      insertProject(_db, { id: 'p2', name: '二' });
      insertProject(_db, { id: 'p3', name: '三', deletedAt: FIXED_TEST_TIME });

      const all = await projects.findActiveNameRefs(null);
      expect(all.map((r) => r.projectId).sort()).toEqual(['p1', 'p2']);
      expect(all.find((r) => r.projectId === 'p2')?.name).toBe('二');

      const excluding = await projects.findActiveNameRefs('p1');
      expect(excluding.map((r) => r.projectId)).toEqual(['p2']);
    });
  });

  it('FormatProfile：findCurrent 返回当前、findAllByProject 升序含历史、JSON 安全区解析进 spec', async () => {
    await withProjectDatabase(async (_db, _projects, profiles) => {
      insertProject(_db, { id: 'p1' });
      insertFormatProfile(_db, { id: 'f1', projectId: 'p1', versionNo: 1, isCurrent: 0 });
      insertFormatProfile(_db, {
        id: 'f2',
        projectId: 'p1',
        versionNo: 2,
        parentId: 'f1',
        isCurrent: 1,
        aspectRatio: '16:9',
        width: 1920,
        height: 1080,
        subtitleSafeAreaJson: JSON.stringify({ top: 0, right: 30, bottom: 12, left: 5 }),
      });

      const current = await profiles.findCurrent('p1');
      expect(current).not.toBeNull();
      if (current === null) {
        throw new Error('current profile must resolve');
      }
      expect(current.id).toBe('f2');
      expect(current.parentId).toBe('f1');
      expect(current.spec.aspectRatio).toBe('16:9');
      expect(current.spec.width).toBe(1920);
      expect(current.spec.subtitleSafeArea).toEqual({ top: 0, right: 30, bottom: 12, left: 5 });

      const history = await profiles.findAllByProject('p1');
      expect(history.map((p) => p.versionNo)).toEqual([1, 2]);
    });
  });

  it('findMaxVersionNo：有版本返回最大、无版本返回 0', async () => {
    await withProjectDatabase(async (_db, _projects, profiles) => {
      insertProject(_db, { id: 'p1' });
      insertFormatProfile(_db, { id: 'f1', projectId: 'p1', versionNo: 1 });
      insertFormatProfile(_db, { id: 'f2', projectId: 'p1', versionNo: 3 });
      expect(await profiles.findMaxVersionNo('p1')).toBe(3);
      expect(await profiles.findMaxVersionNo('p_other')).toBe(0);
    });
  });

  it('findCurrent：无当前版本返回 null（不抛错）', async () => {
    await withProjectDatabase(async (_db, _projects, profiles) => {
      insertProject(_db, { id: 'p1' });
      insertFormatProfile(_db, { id: 'f1', projectId: 'p1', versionNo: 1, isCurrent: 0 });
      expect(await profiles.findCurrent('p1')).toBeNull();
    });
  });

  it('越界安全区：DB 接受 {top:999} 但 row-mapper 归一化为 PersistenceRuntimeError（经 Repository 接口）', async () => {
    await withProjectDatabase(async (_db, _projects, profiles) => {
      insertProject(_db, { id: 'p1' });
      insertFormatProfile(_db, {
        id: 'f1',
        projectId: 'p1',
        versionNo: 1,
        isCurrent: 1,
        subtitleSafeAreaJson: JSON.stringify({ top: 999, right: 5, bottom: 12, left: 5 }),
      });
      await expect(profiles.findCurrent('p1')).rejects.toBeInstanceOf(PersistenceRuntimeError);
      await expect(profiles.findAllByProject('p1')).rejects.toBeInstanceOf(PersistenceRuntimeError);
    });
  });

  it('mapFormatProfileRow：非合法 JSON / 非对象 / 缺字段 / 非数字 都归一化为 PersistenceRuntimeError', () => {
    const base = (overrides: Partial<Row>): Row => ({
      id: 'f1',
      project_id: 'p1',
      version_no: 1,
      parent_id: null,
      aspect_ratio: '9:16',
      width: 1080,
      height: 1920,
      fps: 30,
      language: 'zh-CN',
      subtitle_safe_area_json: DEFAULT_SAFE_AREA,
      is_current: 1,
      created_at: FIXED_TEST_TIME,
      ...overrides,
    });

    expect(() => mapFormatProfileRow(base({ subtitle_safe_area_json: '{not json' }))).toThrow(
      PersistenceRuntimeError,
    );
    expect(() => mapFormatProfileRow(base({ subtitle_safe_area_json: '[]' }))).toThrow(
      PersistenceRuntimeError,
    );
    expect(() =>
      mapFormatProfileRow(base({ subtitle_safe_area_json: JSON.stringify({ top: 5 }) })),
    ).toThrow(PersistenceRuntimeError);
    expect(() =>
      mapFormatProfileRow(
        base({
          subtitle_safe_area_json: JSON.stringify({
            top: 'x',
            right: 5,
            bottom: 12,
            left: 5,
          }),
        }),
      ),
    ).toThrow(PersistenceRuntimeError);
  });

  it('findCurrent：多 current（绕过部分唯一索引的库损坏）归一化为 PersistenceRuntimeError', async () => {
    await withSqliteTestContext(async (context) => {
      const database = new Database(path.join(context.root, 'corrupt.sqlite'));
      applyMigrations(database, await loadMigrationSet(MIGRATION_DIRECTORY), context.clock);
      database.exec('DROP INDEX ux_format_profile_current');
      insertProject(database, { id: 'p1' });
      insertFormatProfile(database, { id: 'f1', projectId: 'p1', versionNo: 1, isCurrent: 1 });
      insertFormatProfile(database, { id: 'f2', projectId: 'p1', versionNo: 2, isCurrent: 1 });

      const profiles = new SqliteFormatProfileRepository(database);
      await expect(profiles.findCurrent('p1')).rejects.toBeInstanceOf(PersistenceRuntimeError);
      database.close();
    });
  });
});
