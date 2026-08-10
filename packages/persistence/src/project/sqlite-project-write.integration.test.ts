import path from 'node:path';

import {
  createFormatProfileSpec,
  normalizeNameKey,
  type FormatProfile,
  type Project,
} from '@jingxu/domain';
import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import {
  SqliteTestDatabase as Database,
  type SqliteTestDatabase,
} from '../testing/sqlite-test-database';
import { FIXED_TEST_TIME, withSqliteTestContext } from '../testing/sqlite-test-kit';
import { SqliteProjectUnitOfWork } from './sqlite-project-unit-of-work';

const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');
const HASH = 'a'.repeat(64);

const project = (id: string, name = `项目-${id}`): Project => ({
  id,
  name,
  genre: null,
  style: null,
  creationMode: 'AI_ORIGINAL',
  dialogueRenderMode: 'NARRATION_FIRST',
  deploymentMode: 'LOCAL_DEMO',
  createdAt: FIXED_TEST_TIME,
  updatedAt: FIXED_TEST_TIME,
  deletedAt: null,
});

const profile = (
  id: string,
  projectId: string,
  versionNo = 1,
  parentId: string | null = null,
): FormatProfile => ({
  id,
  projectId,
  versionNo,
  parentId,
  spec: createFormatProfileSpec(versionNo === 1 ? '9:16' : '16:9', {
    top: 5,
    right: 5,
    bottom: 12,
    left: 5,
  }),
  isCurrent: true,
  createdAt: FIXED_TEST_TIME,
});

const withDatabase = async <T>(
  operation: (database: SqliteTestDatabase, uow: SqliteProjectUnitOfWork) => Promise<T>,
): Promise<T> =>
  withSqliteTestContext(async (context) => {
    const database = new Database(path.join(context.root, 'project-write.sqlite'));
    applyMigrations(database, await loadMigrationSet(MIGRATION_DIRECTORY), context.clock);
    try {
      return await operation(database, new SqliteProjectUnitOfWork(database));
    } finally {
      database.close();
    }
  });

const count = (database: SqliteTestDatabase, table: string): number => {
  const allowed = [
    'projects',
    'format_profiles',
    'audit_events',
    'analytics_events',
    'command_receipts',
  ];
  if (!allowed.includes(table)) throw new Error('unsupported test table');
  const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
  return Number(row?.total ?? 0);
};

const writeCreate = async (uow: SqliteProjectUnitOfWork, id = 'p1'): Promise<void> => {
  await uow.run(async (repositories) => {
    await repositories.projects.insert(project(id));
    await repositories.formatProfiles.insert(profile(`fp-${id}`, id));
    await repositories.audit.record({
      projectId: id,
      action: 'PROJECT_CREATED',
      objectType: 'PROJECT',
      objectId: id,
      traceId: `trace-${id}`,
      occurredAt: FIXED_TEST_TIME,
    });
    await repositories.analytics.record({
      projectId: id,
      eventName: 'project_created',
      properties: { source: 'PROJECT_SETTINGS' },
      occurredAt: FIXED_TEST_TIME,
    });
    await repositories.analytics.record({
      projectId: id,
      eventName: 'dialogue_mode_selected',
      properties: { dialogueRenderMode: 'NARRATION_FIRST', source: 'PROJECT_SETTINGS' },
      occurredAt: FIXED_TEST_TIME,
    });
    await repositories.receipts.insert({
      requestId: `req-${id}`,
      commandName: 'CREATE_PROJECT',
      payloadSha256: HASH,
      projectId: id,
      resultRef: {
        projectId: id,
        formatProfileId: `fp-${id}`,
        updatedAt: FIXED_TEST_TIME,
        changed: true,
      },
      traceId: `trace-${id}`,
      committedAt: FIXED_TEST_TIME,
    });
  });
};

describe('SQLite Project 写事务（§5.3–§5.9）', () => {
  it('在单一事务提交 Project、Profile、Audit、两个 Analytics 与 Receipt', async () => {
    await withDatabase(async (database, uow) => {
      await writeCreate(uow);
      expect(
        ['projects', 'format_profiles', 'audit_events', 'analytics_events', 'command_receipts'].map(
          (table) => count(database, table),
        ),
      ).toEqual([1, 1, 1, 2, 1]);
      const dataRoot = database
        .prepare('SELECT data_root_rel FROM projects WHERE id = ?')
        .get('p1');
      expect(dataRoot?.data_root_rel).toBe('projects/p1');
    });
  });

  it.each([
    ['format_profiles', 'BEFORE INSERT ON format_profiles'],
    ['audit_events', 'BEFORE INSERT ON audit_events'],
    ['analytics_events', 'BEFORE INSERT ON analytics_events'],
    ['command_receipts', 'BEFORE INSERT ON command_receipts'],
  ])('故障点 %s 回滚全部创建证据', async (_table, triggerPoint) => {
    await withDatabase(async (database, uow) => {
      database.exec(
        `CREATE TRIGGER fail_write ${triggerPoint} BEGIN SELECT RAISE(ABORT, 'fault'); END`,
      );
      await expect(writeCreate(uow)).rejects.toThrow();
      expect(
        ['projects', 'format_profiles', 'audit_events', 'analytics_events', 'command_receipts'].map(
          (table) => count(database, table),
        ),
      ).toEqual([0, 0, 0, 0, 0]);
    });
  });

  it('活动名称引用允许 Application 在同一 BEGIN IMMEDIATE 内执行 Unicode 冲突检查，软删除后可复用', async () => {
    await withDatabase(async (_database, uow) => {
      await writeCreate(uow, 'p1');
      const conflict = await uow.run(async (repositories) => {
        const refs = await repositories.projects.findActiveNameRefs(null);
        return refs.some((ref) => normalizeNameKey(ref.name) === normalizeNameKey('项目-P1'));
      });
      expect(conflict).toBe(true);
      await uow.run(async (repositories) => {
        const current = await repositories.projects.findById('p1', 'ACTIVE');
        if (current === null) throw new Error('fixture missing');
        await repositories.projects.update(
          { ...current, deletedAt: FIXED_TEST_TIME, updatedAt: '2026-08-07T00:00:00.001Z' },
          current.updatedAt,
        );
      });
      await expect(
        uow.run((repositories) => repositories.projects.findActiveNameRefs(null)),
      ).resolves.toEqual([]);
    });
  });

  it('乐观更新只命中 expectedUpdatedAt，FormatProfile 切换保留 parent/version/current', async () => {
    await withDatabase(async (_database, uow) => {
      await writeCreate(uow);
      await uow.run(async (repositories) => {
        const currentProject = await repositories.projects.findById('p1', 'ACTIVE');
        const currentProfile = await repositories.formatProfiles.findCurrent('p1');
        if (currentProject === null || currentProfile === null) throw new Error('fixture missing');
        await expect(
          repositories.projects.update(
            { ...currentProject, name: '新名称', updatedAt: '2026-08-07T00:00:00.001Z' },
            'stale',
          ),
        ).resolves.toBe(false);
        await expect(
          repositories.projects.update(
            { ...currentProject, name: '新名称', updatedAt: '2026-08-07T00:00:00.001Z' },
            currentProject.updatedAt,
          ),
        ).resolves.toBe(true);
        await repositories.formatProfiles.unsetCurrent('p1', currentProfile.id);
        await repositories.formatProfiles.insert(profile('fp-v2', 'p1', 2, currentProfile.id));
      });
      const versions = await uow.run((repositories) =>
        repositories.formatProfiles.findAllByProject('p1'),
      );
      expect(
        versions.map(({ id, versionNo, parentId, isCurrent }) => ({
          id,
          versionNo,
          parentId,
          isCurrent,
        })),
      ).toEqual([
        { id: 'fp-p1', versionNo: 1, parentId: null, isCurrent: false },
        { id: 'fp-v2', versionNo: 2, parentId: 'fp-p1', isCurrent: true },
      ]);
    });
  });

  it('FormatProfile 新版本写入失败时回滚 Project 更新与旧 current 切换', async () => {
    await withDatabase(async (database, uow) => {
      await writeCreate(uow);
      database.exec(
        `CREATE TRIGGER fail_profile_v2 BEFORE INSERT ON format_profiles
         WHEN NEW.version_no = 2 BEGIN SELECT RAISE(ABORT, 'profile-v2-fault'); END`,
      );

      await expect(
        uow.run(async (repositories) => {
          const currentProject = await repositories.projects.findById('p1', 'ACTIVE');
          const currentProfile = await repositories.formatProfiles.findCurrent('p1');
          if (currentProject === null || currentProfile === null)
            throw new Error('fixture missing');
          await repositories.projects.update(
            {
              ...currentProject,
              name: '不应提交',
              updatedAt: '2026-08-07T00:00:00.001Z',
            },
            currentProject.updatedAt,
          );
          await repositories.formatProfiles.unsetCurrent('p1', currentProfile.id);
          await repositories.formatProfiles.insert(profile('fp-v2', 'p1', 2, currentProfile.id));
        }),
      ).rejects.toThrow();

      await expect(
        uow.run((repositories) => repositories.projects.findById('p1', 'ACTIVE')),
      ).resolves.toMatchObject({ name: '项目-p1', updatedAt: FIXED_TEST_TIME });
      await expect(
        uow.run((repositories) => repositories.formatProfiles.findCurrent('p1')),
      ).resolves.toMatchObject({ id: 'fp-p1', isCurrent: true });
      expect(count(database, 'format_profiles')).toBe(1);
    });
  });

  it('current FormatProfile 的 ShotContract 引用可被确定性检测', async () => {
    await withDatabase(async (database, uow) => {
      await writeCreate(uow);
      database
        .prepare(
          'INSERT INTO episodes (id, project_id, title, target_duration_sec, current_version_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)',
        )
        .run('ep1', 'p1', '第一集', 60, FIXED_TEST_TIME, FIXED_TEST_TIME);
      database
        .prepare(
          "INSERT INTO shots (id, episode_id, lifecycle_status, current_version_id, created_at, updated_at, deleted_at) VALUES (?, ?, 'ACTIVE', NULL, ?, ?, NULL)",
        )
        .run('shot1', 'ep1', FIXED_TEST_TIME, FIXED_TEST_TIME);
      const document = JSON.stringify({
        version_id: 'sv1',
        shot_id: 'shot1',
        contract_version: 1,
        sequence: 1,
        status: 'DRAFT',
        format_profile_id: 'fp-p1',
        target_duration_sec: 5,
        parent_version_id: null,
        dialogue: { dialogue_render_mode: 'NARRATION_FIRST' },
      });
      database
        .prepare(
          "INSERT INTO shot_contract_versions (id, shot_id, version_no, parent_id, external_parent_version_id, lineage_resolution_status, sequence, version_status, format_profile_id, target_duration_sec, dialogue_render_mode, document_json, document_sha256, source_invocation_id, created_at) VALUES (?, ?, 1, NULL, NULL, 'ROOT', 1, 'DRAFT', ?, 5, 'NARRATION_FIRST', ?, ?, NULL, ?)",
        )
        .run('sv1', 'shot1', 'fp-p1', document, HASH, FIXED_TEST_TIME);
      await expect(
        uow.run((repositories) =>
          repositories.formatProfiles.isCurrentReferencedByShotContract('p1', 'fp-p1'),
        ),
      ).resolves.toBe(true);
      await expect(
        uow.run((repositories) =>
          repositories.formatProfiles.isCurrentReferencedByShotContract('p1', 'missing'),
        ),
      ).resolves.toBe(false);
      const before = [
        'projects',
        'format_profiles',
        'audit_events',
        'analytics_events',
        'command_receipts',
      ].map((table) => count(database, table));
      const blocked = await uow.run(async (repositories) => {
        if (await repositories.formatProfiles.isCurrentReferencedByShotContract('p1', 'fp-p1')) {
          return true;
        }
        throw new Error('fixture must be blocked');
      });
      expect(blocked).toBe(true);
      expect(
        ['projects', 'format_profiles', 'audit_events', 'analytics_events', 'command_receipts'].map(
          (table) => count(database, table),
        ),
      ).toEqual(before);
    });
  });

  it('软删除与恢复只更新 Project，Profile 链保持不变', async () => {
    await withDatabase(async (database, uow) => {
      await writeCreate(uow);
      await uow.run(async (repositories) => {
        const active = await repositories.projects.findById('p1', 'ACTIVE');
        if (active === null) throw new Error('fixture missing');
        await repositories.projects.update(
          {
            ...active,
            deletedAt: '2026-08-07T00:00:00.001Z',
            updatedAt: '2026-08-07T00:00:00.001Z',
          },
          active.updatedAt,
        );
      });
      expect(count(database, 'format_profiles')).toBe(1);
      await uow.run(async (repositories) => {
        const deleted = await repositories.projects.findById('p1', 'DELETED');
        if (deleted === null) throw new Error('fixture missing');
        await repositories.projects.update(
          { ...deleted, deletedAt: null, updatedAt: '2026-08-07T00:00:00.002Z' },
          deleted.updatedAt,
        );
      });
      expect(count(database, 'format_profiles')).toBe(1);
      await expect(
        uow.run((repositories) => repositories.projects.findById('p1', 'ACTIVE')),
      ).resolves.toMatchObject({ deletedAt: null });
    });
  });

  it('软删除审计失败时 Project 与 Receipt 均回滚为活动态', async () => {
    await withDatabase(async (database, uow) => {
      await writeCreate(uow);
      database.exec(
        `CREATE TRIGGER fail_delete_audit BEFORE INSERT ON audit_events
         WHEN NEW.action = 'PROJECT_DELETED' BEGIN SELECT RAISE(ABORT, 'audit-fault'); END`,
      );
      await expect(
        uow.run(async (repositories) => {
          const active = await repositories.projects.findById('p1', 'ACTIVE');
          if (active === null) throw new Error('fixture missing');
          const deletedAt = '2026-08-07T00:00:00.001Z';
          await repositories.projects.update(
            { ...active, deletedAt, updatedAt: deletedAt },
            active.updatedAt,
          );
          await repositories.audit.record({
            projectId: 'p1',
            action: 'PROJECT_DELETED',
            objectType: 'PROJECT',
            objectId: 'p1',
            traceId: 'trace-delete',
            occurredAt: deletedAt,
          });
        }),
      ).rejects.toThrow();
      await expect(
        uow.run((repositories) => repositories.projects.findById('p1', 'ACTIVE')),
      ).resolves.toMatchObject({ deletedAt: null, updatedAt: FIXED_TEST_TIME });
      expect(count(database, 'command_receipts')).toBe(1);
      expect(count(database, 'audit_events')).toBe(1);
    });
  });

  it('Receipt 可跨 adapter 重建且 result_ref 不含用户内容；重复 requestId 由 PK 拒绝并回滚', async () => {
    await withDatabase(async (database, uow) => {
      await writeCreate(uow);
      const fresh = new SqliteProjectUnitOfWork(database);
      const receipt = await fresh.run((repositories) =>
        repositories.receipts.findByRequestId('req-p1'),
      );
      expect(receipt?.resultRef).toEqual({
        projectId: 'p1',
        formatProfileId: 'fp-p1',
        updatedAt: FIXED_TEST_TIME,
        changed: true,
      });
      const raw = database
        .prepare('SELECT result_ref_json FROM command_receipts WHERE request_id = ?')
        .get('req-p1');
      expect(JSON.stringify(raw)).not.toContain('项目-p1');
      if (receipt === null) throw new Error('receipt fixture missing');
      await expect(
        fresh.run((repositories) =>
          repositories.receipts.insert({ ...receipt, payloadSha256: 'b'.repeat(64) }),
        ),
      ).rejects.toThrow();
      expect(count(database, 'command_receipts')).toBe(1);
    });
  });

  it('并发调用在单连接上串行执行，失败事务不阻塞后续事务', async () => {
    await withDatabase(async (_database, uow) => {
      const order: string[] = [];
      const first = uow.run(async () => {
        order.push('first-start');
        await Promise.resolve();
        order.push('first-end');
      });
      const second = uow.run(() => {
        order.push('second');
        return Promise.resolve();
      });
      await Promise.all([first, second]);
      expect(order).toEqual(['first-start', 'first-end', 'second']);
      await expect(uow.run(() => Promise.reject(new Error('rollback')))).rejects.toThrow(
        'rollback',
      );
      await expect(uow.run(() => Promise.resolve('recovered'))).resolves.toBe('recovered');
    });
  });
});
