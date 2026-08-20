import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  createShotEditLockService,
  type ShotEditLockServiceDependencies,
} from '@jingxu/application';
import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { SqliteScriptUnitOfWork } from './sqlite-script-unit-of-work';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-20T00:00:00.000Z';
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const hashPayload = (value: unknown): string => sha256(JSON.stringify(value));

const open = async (root: string): Promise<SqliteTestDatabase> => {
  const database = new SqliteTestDatabase(path.join(root, 'shot-edit-lock.sqlite'));
  database.pragma('foreign_keys = ON');
  applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
  database
    .prepare(
      `INSERT INTO projects
       (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at)
       VALUES ('project_edit', '编辑项目', 'AI_ORIGINAL', 'NARRATION_FIRST', 'LOCAL_DEMO',
               'projects/project_edit', ?, ?)`,
    )
    .run(NOW, NOW);
  database
    .prepare(
      `INSERT INTO format_profiles
       (id, project_id, version_no, aspect_ratio, width, height, fps, language,
        subtitle_safe_area_json, is_current, created_at)
       VALUES ('format_edit', 'project_edit', 1, '9:16', 1080, 1920, 24, 'zh-CN',
               '{"top":5,"right":5,"bottom":10,"left":5}', 1, ?)`,
    )
    .run(NOW);
  database
    .prepare(
      `INSERT INTO story_bible_versions
       (id, project_id, version_no, parent_id, document_json, document_sha256, status, source, source_invocation_id, created_at)
       VALUES ('sbv_edit_1', 'project_edit', 1, NULL, ?, ?, 'READY', 'AI', NULL, ?)`,
    )
    .run(JSON.stringify({ data: { characters: {}, scenes: {} } }), sha256('bible-edit'), NOW);
  database
    .prepare(
      `INSERT INTO episodes
       (id, project_id, title, target_duration_sec, current_version_id, created_at, updated_at, deleted_at)
       VALUES ('episode_edit', 'project_edit', '第一集', 90, NULL, ?, ?, NULL)`,
    )
    .run(NOW, NOW);
  return database;
};

interface SeedResult {
  readonly headVersionId: string;
  readonly shotIds: readonly string[];
}

/** 种下 n 个 ACTIVE 镜头（v1，duration 使集合校验总量落在 30..180）与整集快照 + 阶段头。 */
const seedStoryboard = (database: SqliteTestDatabase, shotCount: number): SeedResult => {
  const shotIds: string[] = [];
  const entries: {
    documentSha256: string;
    sequence: number;
    shotId: string;
    shotVersionId: string;
  }[] = [];
  // 单镜头上限 20s（列 CHECK）；少镜头种子用 15s 保持集合总量 ≥30（集合校验下界）。
  const duration = shotCount >= 5 ? 90 / shotCount : 15;
  for (let index = 1; index <= shotCount; index += 1) {
    const shotId = `shot_edit_${String(index).padStart(2, '0')}`;
    const versionId = `scv_edit_${String(index).padStart(2, '0')}_v1`;
    shotIds.push(shotId);
    const document = {
      acceptance: { must_include: [] },
      cinematography: { shot_size: 'MEDIUM' },
      content: { character_ids: [], scene_id: null, spoken_text: '' },
      contract_version: 1,
      continuity: { continuity_mode: 'NONE', previous_shot_id: null },
      dialogue: { dialogue_render_mode: 'NARRATION_FIRST', speaker_id: null },
      format_profile_id: 'format_edit',
      locked_paths: [],
      narrative_purpose: `镜头 ${String(index)}`,
      parent_version_id: null,
      sequence: index,
      shot_id: shotId,
      status: 'DRAFT',
      target_duration_sec: duration,
      version_id: versionId,
    };
    const documentJson = JSON.stringify(document);
    database
      .prepare(
        `INSERT INTO shots (id, episode_id, lifecycle_status, current_version_id, created_at, updated_at, deleted_at)
         VALUES (?, 'episode_edit', 'ACTIVE', ?, ?, ?, NULL)`,
      )
      .run(shotId, versionId, NOW, NOW);
    database
      .prepare(
        `INSERT INTO shot_contract_versions
         (id, shot_id, version_no, parent_id, external_parent_version_id, lineage_resolution_status,
          sequence, version_status, format_profile_id, target_duration_sec, dialogue_render_mode,
          document_json, document_sha256, source_invocation_id, created_at)
         VALUES (?, ?, 1, NULL, NULL, 'ROOT', ?, 'DRAFT', 'format_edit', ?, 'NARRATION_FIRST', ?, ?, NULL, ?)`,
      )
      .run(versionId, shotId, index, duration, documentJson, sha256(documentJson), NOW);
    entries.push({
      documentSha256: sha256(documentJson),
      sequence: index,
      shotId,
      shotVersionId: versionId,
    });
  }
  const shotSetHash = hashPayload(
    entries.map((entry) => [entry.shotId, entry.shotVersionId, entry.documentSha256]),
  );
  database
    .prepare(
      `INSERT INTO episode_versions
       (id, episode_id, version_no, parent_id, story_bible_version_id, format_profile_id,
        target_duration_sec, shot_set_hash, status, created_at)
       VALUES ('epv_edit_1', 'episode_edit', 1, NULL, 'sbv_edit_1', 'format_edit', 90, ?, 'DRAFT', ?)`,
    )
    .run(shotSetHash, NOW);
  const insertLink = database.prepare(
    'INSERT INTO episode_version_shots (episode_version_id, shot_id, shot_version_id, sequence) VALUES (?, ?, ?, ?)',
  );
  for (const entry of entries)
    insertLink.run('epv_edit_1', entry.shotId, entry.shotVersionId, entry.sequence);
  database
    .prepare(
      `INSERT INTO stage_heads (project_id, episode_id, stage, current_version_type, current_version_id, updated_at)
       VALUES ('project_edit', 'episode_edit', 'SHOT_CONTRACT', 'EPISODE_VERSION', 'epv_edit_1', ?)`,
    )
    .run(NOW);
  return { headVersionId: 'epv_edit_1', shotIds };
};

const seedLock = (database: SqliteTestDatabase, jsonPointer: string): void => {
  database
    .prepare(
      `INSERT INTO lock_records
       (id, project_id, object_type, object_id, object_version_id, json_pointer, locked_by, note, locked_at, unlocked_at)
       VALUES ('lock_seed_1', 'project_edit', 'SHOT_CONTRACT', 'shot_edit_01', 'scv_edit_01_v1', ?, 'USER', NULL, ?, NULL)`,
    )
    .run(jsonPointer, NOW);
};

const dependencies = (
  newId: () => string,
  unitOfWork: SqliteScriptUnitOfWork,
): ShotEditLockServiceDependencies => ({
  hashPayload,
  hashText: sha256,
  newId,
  now: () => NOW,
  unitOfWork,
  validateShotDocument: () => ({ valid: true }),
});

const countRows = (database: SqliteTestDatabase, sql: string, ...args: readonly string[]): number =>
  (database.prepare(sql).get(...args) as { value: number }).value;

describe('SQLite 分镜编辑/锁定事务（shot-edit-lock 2.1/2.2）', () => {
  it('编辑事务 SQL 接线—新 scv 满足列绑定 CHECK、20 镜头完整快照、sequence 连续、shotSetHash 复算一致', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await open(root);
      try {
        const unitOfWork = new SqliteScriptUnitOfWork(database);
        const seed = seedStoryboard(database, 20);
        let idSequence = 0;
        const service = createShotEditLockService(
          dependencies(() => {
            idSequence += 1;
            return `gen${String(idSequence)}`;
          }, unitOfWork),
        );

        const shot = shotDocumentOf(database, 'scv_edit_07_v1');
        const result = await service.editShot(
          {
            document: { ...shot, target_duration_sec: 5 },
            episodeId: 'episode_edit',
            expectedVersionId: seed.headVersionId,
            projectId: 'project_edit',
            requestId: 'req-edit-20',
            shotId: 'shot_edit_07',
            shotVersionId: 'scv_edit_07_v1',
          },
          'trace-1',
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const newShotVersionId = result.data.shotVersionId;
        expect(newShotVersionId).toBe('scv_gen1_v2');

        // 新 episode_version：20 条完整快照，sequence 1..20 连续，编辑镜头指向 v2。
        const links = (
          database
            .prepare(
              'SELECT shot_id, shot_version_id, sequence FROM episode_version_shots WHERE episode_version_id=? ORDER BY sequence',
            )
            .all(result.data.episode.id) as {
            shot_id: string;
            shot_version_id: string;
            sequence: number;
          }[]
        ).map((row) => ({
          sequence: row.sequence,
          shotId: row.shot_id,
          shotVersionId: row.shot_version_id,
        }));
        expect(links).toHaveLength(20);
        expect(links.map((link) => link.sequence)).toEqual(
          Array.from({ length: 20 }, (_, i) => i + 1),
        );
        expect(links[6]).toEqual({
          sequence: 7,
          shotId: 'shot_edit_07',
          shotVersionId: newShotVersionId,
        });
        expect(links[19]?.shotVersionId).toBe('scv_edit_20_v1');

        // shotSetHash 复算一致（与 seed 同源算法）。
        const entries = links.map((link) => {
          const row = database
            .prepare('SELECT document_sha256 FROM shot_contract_versions WHERE id=?')
            .get(link.shotVersionId) as { document_sha256: string };
          return [link.shotId, link.shotVersionId, row.document_sha256];
        });
        expect(result.data.episode.shotSetHash).toBe(hashPayload(entries));

        // 指针推进 + 阶段头移动 + 回执同事务落库。
        expect(
          database.prepare('SELECT current_version_id FROM shots WHERE id=?').get('shot_edit_07'),
        ).toMatchObject({ current_version_id: newShotVersionId });
        expect(
          database
            .prepare('SELECT current_version_id FROM stage_heads WHERE project_id=? AND stage=?')
            .get('project_edit', 'SHOT_CONTRACT'),
        ).toMatchObject({ current_version_id: result.data.episode.id });
        expect(
          countRows(
            database,
            'SELECT COUNT(*) AS value FROM command_receipts WHERE request_id=?',
            'req-edit-20',
          ),
        ).toBe(1);
        expect(
          countRows(
            database,
            "SELECT COUNT(*) AS value FROM audit_events WHERE action='SHOT_EDITED'",
          ),
        ).toBe(1);
      } finally {
        database.close();
      }
    });
  });

  it('原子性—事务中途失败整体回滚，无 scv 残留、lock_records 无孤儿、head 不动', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await open(root);
      try {
        const unitOfWork = new SqliteScriptUnitOfWork(database);
        const seed = seedStoryboard(database, 2);
        seedLock(database, '/dialogue');
        // 预埋主键冲突：newId 第 2 次调用生成的新 episode_version id 与既有行相撞。
        database
          .prepare(
            `INSERT INTO episode_versions
             (id, episode_id, version_no, parent_id, story_bible_version_id, format_profile_id,
              target_duration_sec, shot_set_hash, status, created_at)
             VALUES ('epv_collision', 'episode_edit', 99, NULL, 'sbv_edit_1', 'format_edit', 90, ?, 'DRAFT', ?)`,
          )
          .run(sha256('collision'), NOW);
        let idSequence = 0;
        const service = createShotEditLockService(
          dependencies(() => {
            idSequence += 1;
            return idSequence === 2 ? 'epv_collision' : `gen${String(idSequence)}`;
          }, unitOfWork),
        );

        const shot = shotDocumentOf(database, 'scv_edit_01_v1');
        const result = await service.editShot(
          {
            document: { ...shot, narrative_purpose: '改写' },
            episodeId: 'episode_edit',
            expectedVersionId: seed.headVersionId,
            projectId: 'project_edit',
            requestId: 'req-edit-fail',
            shotId: 'shot_edit_01',
            shotVersionId: 'scv_edit_01_v1',
          },
          'trace-1',
        );

        expect(result).toMatchObject({ ok: false, error: { code: 'PROJECT_PERSISTENCE_FAILED' } });
        // 回滚断言：仅种子两行 scv，无 v2 残留；锁记录仍恰好 1 行（无孤儿、无解锁漂移）。
        expect(countRows(database, 'SELECT COUNT(*) AS value FROM shot_contract_versions')).toBe(2);
        expect(countRows(database, 'SELECT COUNT(*) AS value FROM lock_records')).toBe(1);
        expect(
          countRows(
            database,
            'SELECT COUNT(*) AS value FROM lock_records WHERE unlocked_at IS NULL',
          ),
        ).toBe(1);
        expect(
          countRows(
            database,
            'SELECT COUNT(*) AS value FROM command_receipts WHERE request_id=?',
            'req-edit-fail',
          ),
        ).toBe(0);
        expect(
          database
            .prepare('SELECT current_version_id FROM stage_heads WHERE project_id=? AND stage=?')
            .get('project_edit', 'SHOT_CONTRACT'),
        ).toMatchObject({ current_version_id: 'epv_edit_1' });
        expect(
          database.prepare('SELECT current_version_id FROM shots WHERE id=?').get('shot_edit_01'),
        ).toMatchObject({ current_version_id: 'scv_edit_01_v1' });
      } finally {
        database.close();
      }
    });
  });

  it('不可变触发器下 lock 版本化—lock/unlock 各创建新 scv 版本，v1 文档不变，lock_records 状态机正确', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await open(root);
      try {
        const unitOfWork = new SqliteScriptUnitOfWork(database);
        const seed = seedStoryboard(database, 2);
        const v1Document = shotDocumentOf(database, 'scv_edit_01_v1');
        let idSequence = 0;
        const service = createShotEditLockService(
          dependencies(() => {
            idSequence += 1;
            return `lock${String(idSequence)}`;
          }, unitOfWork),
        );
        const lockInput = {
          episodeId: 'episode_edit',
          expectedVersionId: seed.headVersionId,
          jsonPointer: '/dialogue',
          note: '台词定稿',
          projectId: 'project_edit',
          requestId: 'req-lock-1',
          shotId: 'shot_edit_01',
        };

        const locked = await service.lockShot(lockInput, 'trace-1');
        expect(locked.ok).toBe(true);
        if (!locked.ok) return;
        expect(locked.data.lockedPaths).toEqual(['/dialogue']);
        const v2Id = locked.data.shotVersionId;
        expect(v2Id).toBe('scv_lock1_v2');
        expect(shotDocumentOf(database, v2Id)).toEqual({
          ...v1Document,
          contract_version: 2,
          locked_paths: ['/dialogue'],
          parent_version_id: 'scv_edit_01_v1',
          version_id: v2Id,
        });
        // v1 不可变：原文档逐字节不变。
        expect(shotDocumentOf(database, 'scv_edit_01_v1')).toEqual(v1Document);
        const lockRow = database
          .prepare(
            'SELECT json_pointer, locked_by, note, unlocked_at FROM lock_records WHERE object_id=?',
          )
          .get('shot_edit_01') as {
          json_pointer: string;
          locked_by: string;
          note: string | null;
          unlocked_at: string | null;
        };
        expect(lockRow).toEqual({
          json_pointer: '/dialogue',
          locked_by: 'USER',
          note: '台词定稿',
          unlocked_at: null,
        });
        // 锁定无回执（D6）。
        expect(
          countRows(
            database,
            'SELECT COUNT(*) AS value FROM command_receipts WHERE request_id=?',
            'req-lock-1',
          ),
        ).toBe(0);

        const unlocked = await service.unlockShot(
          { ...lockInput, expectedVersionId: locked.data.episode.id },
          'trace-2',
        );
        expect(unlocked.ok).toBe(true);
        if (!unlocked.ok) return;
        expect(unlocked.data.lockedPaths).toEqual([]);
        expect(shotDocumentOf(database, unlocked.data.shotVersionId)).toMatchObject({
          locked_paths: [],
        });
        const unlockedRow = database
          .prepare('SELECT unlocked_at FROM lock_records WHERE object_id=?')
          .get('shot_edit_01') as { unlocked_at: string | null };
        expect(unlockedRow.unlocked_at).toBe(NOW);
        // 版本链：v1 种子 + lock v2 + unlock v3。
        expect(
          countRows(
            database,
            'SELECT COUNT(*) AS value FROM shot_contract_versions WHERE shot_id=?',
            'shot_edit_01',
          ),
        ).toBe(3);
      } finally {
        database.close();
      }
    });
  });
});

/** 读取存储的镜头文档（对象形态）。 */
const shotDocumentOf = (
  database: SqliteTestDatabase,
  versionId: string,
): Record<string, unknown> => {
  const row = database
    .prepare('SELECT document_json FROM shot_contract_versions WHERE id=?')
    .get(versionId) as { document_json: string };
  return JSON.parse(row.document_json) as Record<string, unknown>;
};
