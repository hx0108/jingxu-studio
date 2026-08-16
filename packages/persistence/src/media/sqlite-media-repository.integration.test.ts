import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteMediaUnitOfWork } from './sqlite-media-unit-of-work';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-16T00:00:00.000Z';
const MODEL_ID = 'doubao-seedream-5-0-lite-260128';

/** 0009 CHECK 要求 generation_input_hash 为 64 个字符；测试种子按前缀展开成定长哈希形态。 */
const hash64 = (seed: string): string => `${seed}_${'.'.repeat(64)}`.slice(0, 64);

const setup = async (root: string, fileName: string): Promise<SqliteTestDatabase> => {
  const database = new SqliteTestDatabase(path.join(root, fileName));
  try {
    database.pragma('foreign_keys = ON');
    const migrations = await loadMigrationSet(MIGRATIONS);
    applyMigrations(database, migrations, () => NOW);
    database
      .prepare(
        `INSERT INTO projects
         (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at)
         VALUES ('project_media', '媒体项目', 'AI_ORIGINAL', 'NARRATION_FIRST', 'LOCAL_DEMO',
                 'projects/project_media', ?, ?)`,
      )
      .run(NOW, NOW);
    database
      .prepare(
        `INSERT INTO format_profiles
         (id, project_id, version_no, aspect_ratio, width, height, fps, language,
          subtitle_safe_area_json, is_current, created_at)
         VALUES ('format_media', 'project_media', 1, '9:16', 1440, 2560, 24, 'zh-CN', '{}', 1, ?)`,
      )
      .run(NOW);
    database
      .prepare(
        `INSERT INTO episodes (id, project_id, title, target_duration_sec, created_at, updated_at)
         VALUES ('episode_media', 'project_media', '第一集', 90, ?, ?)`,
      )
      .run(NOW, NOW);
    insertShot(database, 'shot_media', 'shotv_media');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

const insertShot = (database: SqliteTestDatabase, shotId: string, versionId: string): void => {
  database
    .prepare(
      `INSERT INTO shots (id, episode_id, lifecycle_status, created_at, updated_at)
       VALUES (?, 'episode_media', 'ACTIVE', ?, ?)`,
    )
    .run(shotId, NOW, NOW);
  database
    .prepare(
      `INSERT INTO shot_contract_versions
       (id, shot_id, version_no, lineage_resolution_status, sequence, version_status, format_profile_id,
        target_duration_sec, dialogue_render_mode, document_json, document_sha256, created_at)
       VALUES (?, ?, 1, 'ROOT', 1, 'DRAFT', 'format_media', 8, 'NARRATION_FIRST', '{}', ?, ?)`,
    )
    .run(versionId, shotId, `sha_${versionId}`, NOW);
};

describe('SqliteMediaRepository / SqliteMediaUnitOfWork', () => {
  it('资产建档—身份查询为空→建档成功→业务键冲突稳定报错', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'media_repo_asset.sqlite');
      try {
        const unitOfWork = new SqliteMediaUnitOfWork(database, () => NOW);
        await expect(
          unitOfWork.run((media) =>
            media.findAssetByIdentity('project_media', 'CHARACTER', 'char_1'),
          ),
        ).resolves.toBeNull();
        const asset = await unitOfWork.run((media) =>
          media.createAsset({
            assetType: 'CHARACTER',
            bibleRefId: 'char_1',
            displayName: '主角',
            id: 'asset_1',
            projectId: 'project_media',
          }),
        );
        expect(asset).toMatchObject({
          assetType: 'CHARACTER',
          bibleRefId: 'char_1',
          createdAt: NOW,
          displayName: '主角',
          id: 'asset_1',
          projectId: 'project_media',
          updatedAt: NOW,
        });
        await expect(
          unitOfWork.run((media) =>
            media.createAsset({
              assetType: 'CHARACTER',
              bibleRefId: 'char_1',
              displayName: '主角·冲突',
              id: 'asset_2',
              projectId: 'project_media',
            }),
          ),
        ).rejects.toThrow('MEDIA_ASSET_CONFLICT');
        await expect(
          unitOfWork.run((media) => media.findAssetByIdentity('project_media', 'SCENE', 'char_1')),
        ).resolves.toBeNull();
      } finally {
        database.close();
      }
    });
  });

  it('资产升版—version_no 自动递增并挂接父版本—listVersions 聚合升序', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'media_repo_version.sqlite');
      try {
        const unitOfWork = new SqliteMediaUnitOfWork(database, () => NOW);
        await unitOfWork.run((media) =>
          media.createAsset({
            assetType: 'SCENE',
            bibleRefId: 'scene_1',
            displayName: '雨巷',
            id: 'asset_1',
            projectId: 'project_media',
          }),
        );
        const first = await unitOfWork.run((media) =>
          media.appendAssetVersion({
            assetId: 'asset_1',
            byteSize: 2048,
            fileSha256: 'a'.repeat(64),
            id: 'version_1',
            mimeType: 'image/png',
          }),
        );
        const second = await unitOfWork.run((media) =>
          media.appendAssetVersion({
            assetId: 'asset_1',
            byteSize: 4096,
            description: '重绘后参考图',
            fileSha256: 'b'.repeat(64),
            height: 512,
            id: 'version_2',
            mimeType: 'image/png',
            width: 384,
          }),
        );
        expect(first).toMatchObject({
          parentVersionId: null,
          provenance: 'UPLOADED',
          versionNo: 1,
        });
        expect(second).toMatchObject({
          parentVersionId: 'version_1',
          versionNo: 2,
          width: 384,
        });
        const assets = await unitOfWork.run((media) => media.listAssets('project_media'));
        expect(assets).toHaveLength(1);
        expect(assets[0]?.asset.id).toBe('asset_1');
        expect(assets[0]?.versions.map((version) => version.id)).toEqual([
          'version_1',
          'version_2',
        ]);
        expect(assets[0]?.versions[1]?.description).toBe('重绘后参考图');
      } finally {
        database.close();
      }
    });
  });

  it('候选批量落库—round 递增 index 连续—成功与失败终态一次性落位', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'media_repo_candidates.sqlite');
      try {
        const unitOfWork = new SqliteMediaUnitOfWork(database, () => NOW);
        const round1 = await unitOfWork.run((media) =>
          media.insertCandidates({
            candidateIds: ['cand_a', 'cand_b', 'cand_c', 'cand_d'],
            generationInputHash: hash64('h1'),
            modelId: MODEL_ID,
            projectId: 'project_media',
            roundNo: 1,
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        expect(round1.map((candidate) => [candidate.roundNo, candidate.indexInRound])).toEqual([
          [1, 0],
          [1, 1],
          [1, 2],
          [1, 3],
        ]);
        expect(round1[0]).toMatchObject({
          byteSize: null,
          errorCode: null,
          fileSha256: null,
          selectedAt: null,
          status: 'PENDING',
        });
        const succeeded = await unitOfWork.run((media) =>
          media.completeCandidateSucceeded('cand_a', {
            byteSize: 1024,
            fileSha256: 'e'.repeat(64),
            height: 64,
            invocationEvidenceRef: 'invocation_1',
            mimeType: 'image/png',
            storageRelPath: 'projects/project_media/images/ee/eeee.png',
            width: 64,
          }),
        );
        expect(succeeded).toMatchObject({
          byteSize: 1024,
          fileSha256: 'e'.repeat(64),
          status: 'SUCCEEDED',
          storageRelPath: 'projects/project_media/images/ee/eeee.png',
        });
        const failed = await unitOfWork.run((media) =>
          media.completeCandidateFailed('cand_b', {
            errorCode: 'MODEL_CONTENT_REJECTED',
            invocationEvidenceRef: 'invocation_2',
          }),
        );
        expect(failed).toMatchObject({
          errorCode: 'MODEL_CONTENT_REJECTED',
          fileSha256: null,
          status: 'FAILED',
        });
        const round2 = await unitOfWork.run((media) =>
          media.insertCandidates({
            candidateIds: ['cand_e'],
            generationInputHash: hash64('h2'),
            modelId: MODEL_ID,
            projectId: 'project_media',
            roundNo: 2,
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        expect(round2[0]?.roundNo).toBe(2);
        const listed = await unitOfWork.run((media) => media.listCandidates('shot_media'));
        expect(listed.map((candidate) => candidate.id)).toEqual([
          'cand_a',
          'cand_b',
          'cand_c',
          'cand_d',
          'cand_e',
        ]);
        expect(listed.filter((candidate) => candidate.status === 'PENDING')).toHaveLength(3);
      } finally {
        database.close();
      }
    });
  });

  it('选择指针—先清后设唯一—FAILED 不可选—跨镜头拒绝', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'media_repo_select.sqlite');
      try {
        insertShot(database, 'shot_other', 'shotv_other');
        const unitOfWork = new SqliteMediaUnitOfWork(database, () => NOW);
        await seedSucceededCandidate(unitOfWork, 'cand_a', hash64('h1'));
        await seedSucceededCandidate(unitOfWork, 'cand_b', hash64('h1'), undefined, undefined, 2);
        await seedSucceededCandidate(
          unitOfWork,
          'cand_other',
          hash64('h3'),
          'shot_other',
          'shotv_other',
        );
        await unitOfWork.run((media) =>
          media.insertCandidates({
            candidateIds: ['cand_fail'],
            generationInputHash: hash64('h1'),
            modelId: MODEL_ID,
            projectId: 'project_media',
            roundNo: 3,
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        await unitOfWork.run((media) =>
          media.completeCandidateFailed('cand_fail', {
            errorCode: 'MODEL_CONTENT_REJECTED',
            invocationEvidenceRef: 'invocation_fail',
          }),
        );

        await unitOfWork.run((media) => media.selectCandidate('shot_media', 'cand_a'));
        expect(selectedRows(database, 'shot_media')).toEqual([
          { id: 'cand_a', selected_by_context: 'USER' },
        ]);
        await unitOfWork.run((media) => media.selectCandidate('shot_media', 'cand_b'));
        expect(selectedRows(database, 'shot_media')).toEqual([
          { id: 'cand_b', selected_by_context: 'USER' },
        ]);
        await expect(
          unitOfWork.run((media) => media.selectCandidate('shot_media', 'cand_fail')),
        ).rejects.toThrow('MEDIA_CANDIDATE_NOT_SELECTABLE');
        await expect(
          unitOfWork.run((media) => media.selectCandidate('shot_media', 'cand_other')),
        ).rejects.toThrow('MEDIA_CANDIDATE_NOT_FOUND');
        expect(selectedRows(database, 'shot_media')).toEqual([
          { id: 'cand_b', selected_by_context: 'USER' },
        ]);
      } finally {
        database.close();
      }
    });
  });

  it('STALE 传播—按世代哈希跨镜头聚合摘要—文件字段与选择指针保留', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'media_repo_stale_hash.sqlite');
      try {
        insertShot(database, 'shot_other', 'shotv_other');
        const unitOfWork = new SqliteMediaUnitOfWork(database, () => NOW);
        await seedSucceededCandidate(unitOfWork, 'cand_a', hash64('h_shared'));
        await seedSucceededCandidate(
          unitOfWork,
          'cand_other',
          hash64('h_shared'),
          'shot_other',
          'shotv_other',
        );
        await seedSucceededCandidate(
          unitOfWork,
          'cand_b',
          hash64('h_private'),
          undefined,
          undefined,
          2,
        );
        await unitOfWork.run((media) => media.selectCandidate('shot_media', 'cand_a'));

        const affected = await unitOfWork.run((media) =>
          media.markCandidatesStaleByGenerationInputHash(hash64('h_shared')),
        );
        expect(affected).toEqual([
          { candidateCount: 1, shotId: 'shot_media' },
          { candidateCount: 1, shotId: 'shot_other' },
        ]);
        const rows = database
          .prepare(
            `SELECT id, status, error_code, file_sha256, selected_at, selected_by_context
             FROM image_candidates ORDER BY id`,
          )
          .all() as unknown as readonly {
          error_code: string | null;
          file_sha256: string | null;
          id: string;
          selected_at: string | null;
          selected_by_context: string | null;
          status: string;
        }[];
        const byId = new Map(rows.map((row) => [row.id, row]));
        expect(byId.get('cand_a')).toMatchObject({
          error_code: null,
          file_sha256: 'f'.repeat(64),
          selected_at: NOW,
          selected_by_context: 'USER',
          status: 'STALE_INPUT',
        });
        expect(byId.get('cand_other')).toMatchObject({ status: 'STALE_INPUT' });
        expect(byId.get('cand_b')).toMatchObject({ status: 'SUCCEEDED' });
        await expect(
          unitOfWork.run((media) =>
            media.markCandidatesStaleByGenerationInputHash(hash64('h_shared')),
          ),
        ).resolves.toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('STALE 传播—按镜头版本覆盖全部非终态并幂等', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'media_repo_stale_version.sqlite');
      try {
        const unitOfWork = new SqliteMediaUnitOfWork(database, () => NOW);
        await seedSucceededCandidate(unitOfWork, 'cand_ok', hash64('h1'));
        await unitOfWork.run((media) =>
          media.insertCandidates({
            candidateIds: ['cand_wait', 'cand_bad'],
            generationInputHash: hash64('h1'),
            modelId: MODEL_ID,
            projectId: 'project_media',
            roundNo: 2,
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        await unitOfWork.run((media) =>
          media.completeCandidateFailed('cand_bad', {
            errorCode: 'MODEL_CONTENT_REJECTED',
            invocationEvidenceRef: 'invocation_bad',
          }),
        );

        const affected = await unitOfWork.run((media) =>
          media.markCandidatesStaleByShotVersion('shotv_media'),
        );
        expect(affected).toEqual([{ candidateCount: 3, shotId: 'shot_media' }]);
        const statuses = database
          .prepare('SELECT id, status, error_code FROM image_candidates ORDER BY id')
          .all() as unknown as readonly { error_code: string | null; id: string; status: string }[];
        expect(statuses).toEqual([
          { error_code: null, id: 'cand_bad', status: 'STALE_INPUT' },
          { error_code: null, id: 'cand_ok', status: 'STALE_INPUT' },
          { error_code: null, id: 'cand_wait', status: 'STALE_INPUT' },
        ]);
        await expect(
          unitOfWork.run((media) => media.markCandidatesStaleByShotVersion('shotv_media')),
        ).resolves.toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('事务边界—work 中途抛出整体回滚', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'media_repo_rollback.sqlite');
      try {
        const unitOfWork = new SqliteMediaUnitOfWork(database, () => NOW);
        await expect(
          unitOfWork.run(async (media) => {
            await media.insertCandidates({
              candidateIds: ['cand_a', 'cand_b'],
              generationInputHash: hash64('h1'),
              modelId: MODEL_ID,
              projectId: 'project_media',
              roundNo: 1,
              shotId: 'shot_media',
              shotVersionId: 'shotv_media',
            });
            await media.createAsset({
              assetType: 'CHARACTER',
              bibleRefId: 'char_1',
              displayName: '主角',
              id: 'asset_1',
              projectId: 'project_media',
            });
            throw new Error('generation_failed_midway');
          }),
        ).rejects.toThrow('generation_failed_midway');
        expect(database.prepare('SELECT COUNT(*) AS count FROM image_candidates').get()).toEqual({
          count: 0,
        });
        expect(database.prepare('SELECT COUNT(*) AS count FROM assets').get()).toEqual({
          count: 0,
        });
        // 回滚后连接仍可用（队列未卡死）。
        await expect(
          unitOfWork.run((media) => media.listCandidates('shot_media')),
        ).resolves.toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('不可变约束—asset_versions 任意 UPDATE 被 trigger 拒绝', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'media_repo_immutable.sqlite');
      try {
        const unitOfWork = new SqliteMediaUnitOfWork(database, () => NOW);
        await unitOfWork.run(async (media) => {
          await media.createAsset({
            assetType: 'CHARACTER',
            bibleRefId: 'char_1',
            displayName: '主角',
            id: 'asset_1',
            projectId: 'project_media',
          });
          await media.appendAssetVersion({
            assetId: 'asset_1',
            byteSize: 2048,
            fileSha256: 'a'.repeat(64),
            id: 'version_1',
            mimeType: 'image/png',
          });
        });
        expect(() =>
          database.prepare('UPDATE asset_versions SET byte_size = 1 WHERE id = ?').run('version_1'),
        ).toThrow(/IMMUTABLE_VERSION_ROW/u);
        expect(
          database.prepare('SELECT byte_size FROM asset_versions WHERE id = ?').get('version_1'),
        ).toEqual({ byte_size: 2048 });
      } finally {
        database.close();
      }
    });
  });

  it('findCurrentAssetVersion—按业务键取最新版本—无资产或无版本返回 null', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'media_repo_current_version.sqlite');
      try {
        const unitOfWork = new SqliteMediaUnitOfWork(database, () => NOW);
        await expect(
          unitOfWork.run((media) =>
            media.findCurrentAssetVersion('project_media', 'SCENE', 'scene_1'),
          ),
        ).resolves.toBeNull();
        await unitOfWork.run(async (media) => {
          await media.createAsset({
            assetType: 'SCENE',
            bibleRefId: 'scene_1',
            displayName: '雨巷',
            id: 'asset_scene',
            projectId: 'project_media',
          });
          // 建了资产但从未上传参考图 → null。
        });
        await expect(
          unitOfWork.run((media) =>
            media.findCurrentAssetVersion('project_media', 'SCENE', 'scene_1'),
          ),
        ).resolves.toBeNull();
        await unitOfWork.run(async (media) => {
          await media.appendAssetVersion({
            assetId: 'asset_scene',
            byteSize: 100,
            fileSha256: 'b'.repeat(64),
            id: 'version_b1',
            mimeType: 'image/png',
          });
          await media.appendAssetVersion({
            assetId: 'asset_scene',
            byteSize: 200,
            fileSha256: 'c'.repeat(64),
            id: 'version_b2',
            mimeType: 'image/png',
          });
        });
        await expect(
          unitOfWork.run((media) =>
            media.findCurrentAssetVersion('project_media', 'SCENE', 'scene_1'),
          ),
        ).resolves.toMatchObject({ id: 'version_b2', parentVersionId: 'version_b1', versionNo: 2 });
      } finally {
        database.close();
      }
    });
  });

  it('媒体任务状态机—建档/幂等键冲突—相位转移守卫矩阵—未终态扫描', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'media_repo_task_fsm.sqlite');
      try {
        const unitOfWork = new SqliteMediaUnitOfWork(database, () => NOW);
        const insertTask = (
          id: string,
          idempotencyKey: string,
          shotId = 'shot_media',
          shotVersionId = 'shotv_media',
        ) =>
          unitOfWork.run((media) =>
            media.insertTask({
              candidateCount: 4,
              generationInputHash: hash64('gen_1'),
              id,
              idempotencyKey,
              projectId: 'project_media',
              shotId,
              shotVersionId,
            }),
          );
        const task = await insertTask('task_1', 'req_1');
        expect(task).toMatchObject({
          candidateCount: 4,
          errorCode: null,
          generationInputHash: hash64('gen_1'),
          id: 'task_1',
          idempotencyKey: 'req_1',
          phase: 'SUBMITTED',
          providerTaskId: null,
          roundNo: 1,
        });
        // 幂等键冲突（并发重放兜底）。
        await expect(insertTask('task_2', 'req_1')).rejects.toThrow(
          'MEDIA_TASK_IDEMPOTENCY_CONFLICT',
        );
        // 幂等读侧。
        await expect(
          unitOfWork.run((media) => media.findTaskByIdempotencyKey('project_media', 'req_1')),
        ).resolves.toMatchObject({ id: 'task_1' });
        await expect(
          unitOfWork.run((media) => media.findTaskById('project_media', 'task_1')),
        ).resolves.toMatchObject({ id: 'task_1' });
        await expect(
          unitOfWork.run((media) => media.findTaskById('project_media', 'task_missing')),
        ).resolves.toBeNull();

        // SUBMITTED→POLLING 首次 poll 前持久化 provider_task_id（spec 不变式）。
        await expect(
          unitOfWork.run((media) => media.markTaskPolling('task_1', 'provider_t1')),
        ).resolves.toMatchObject({ phase: 'POLLING', providerTaskId: 'provider_t1' });
        // 重复 markTaskPolling（同参数）幂等安全。
        await expect(
          unitOfWork.run((media) => media.markTaskPolling('task_1', 'provider_t1')),
        ).resolves.toMatchObject({ phase: 'POLLING' });
        // POLLING→DOWNLOADING；终态后一切转移被拒。
        await expect(
          unitOfWork.run((media) => media.markTaskDownloading('task_1')),
        ).resolves.toMatchObject({ phase: 'DOWNLOADING' });
        await expect(
          unitOfWork.run((media) => media.markTaskPolling('task_1', 'provider_t2')),
        ).rejects.toThrow('MEDIA_TASK_ALREADY_TERMINAL');
        await expect(
          unitOfWork.run((media) => media.completeTask('task_1')),
        ).resolves.toMatchObject({ phase: 'COMPLETED' });
        await expect(
          unitOfWork.run((media) => media.completeTask('task_1')),
        ).resolves.toMatchObject({ phase: 'COMPLETED' });
        await expect(unitOfWork.run((media) => media.cancelTask('task_1'))).rejects.toThrow(
          'MEDIA_TASK_ALREADY_TERMINAL',
        );
        // 完成后未终态扫描不再包含该任务。
        await expect(
          unitOfWork.run((media) => media.listUnfinishedTasks('project_media')),
        ).resolves.toEqual([]);

        // 第二个任务：非终态取消 + 失败路径错误码（异镜头避开 UNIQUE(shot_id, round_no)）。
        insertShot(database, 'shot_cancel', 'shotv_cancel');
        insertShot(database, 'shot_fail', 'shotv_fail');
        await insertTask('task_3', 'req_3', 'shot_cancel', 'shotv_cancel');
        await expect(unitOfWork.run((media) => media.cancelTask('task_3'))).resolves.toMatchObject({
          phase: 'CANCELLED',
        });
        await insertTask('task_4', 'req_4', 'shot_fail', 'shotv_fail');
        await expect(
          unitOfWork.run((media) => media.failTask('task_4', 'MODEL_RATE_LIMITED')),
        ).resolves.toMatchObject({ errorCode: 'MODEL_RATE_LIMITED', phase: 'FAILED' });
        // 不存在任务 id 的稳定错误。
        await expect(unitOfWork.run((media) => media.completeTask('task_missing'))).rejects.toThrow(
          'MEDIA_TASK_NOT_FOUND',
        );

        // 任务↔轮一一对应：建档时派生 max(round_no)+1；同镜头第二轮任务被
        // UNIQUE(shot_id, round_no) 拒绝（新轮须先落上一轮候选）。
        await seedSucceededCandidate(unitOfWork, 'cand_round1', hash64('gen_1'));
        const taskRound2 = await insertTask('task_5', 'req_5');
        expect(taskRound2).toMatchObject({ roundNo: 2 });
        await expect(insertTask('task_6', 'req_6')).rejects.toThrow(
          'MEDIA_TASK_IDEMPOTENCY_CONFLICT',
        );

        // 候选级 provider_task_id 留证（spec：首次 poll 前持久化）。
        const pendingRound = await unitOfWork.run((media) =>
          media.insertCandidates({
            candidateIds: ['cand_p1', 'cand_p2'],
            generationInputHash: hash64('gen_3'),
            modelId: MODEL_ID,
            projectId: 'project_media',
            roundNo: 2,
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        expect(pendingRound.every((candidate) => candidate.providerTaskId === null)).toBe(true);
        await expect(
          unitOfWork.run((media) => media.assignCandidateProviderTask('cand_p1', 'pt_1')),
        ).resolves.toMatchObject({ providerTaskId: 'pt_1', status: 'PENDING' });
        // 幂等重放（同 taskId）安全；不同 taskId / 非 PENDING / 不存在分别稳定拒绝。
        await expect(
          unitOfWork.run((media) => media.assignCandidateProviderTask('cand_p1', 'pt_1')),
        ).resolves.toMatchObject({ providerTaskId: 'pt_1' });
        await expect(
          unitOfWork.run((media) => media.assignCandidateProviderTask('cand_p1', 'pt_2')),
        ).rejects.toThrow('MEDIA_CANDIDATE_TASK_CONFLICT');
        await expect(
          unitOfWork.run((media) => media.assignCandidateProviderTask('cand_round1', 'pt_3')),
        ).rejects.toThrow('MEDIA_CANDIDATE_TASK_CONFLICT');
        await expect(
          unitOfWork.run((media) => media.assignCandidateProviderTask('cand_missing', 'pt_4')),
        ).rejects.toThrow('MEDIA_CANDIDATE_NOT_FOUND');
      } finally {
        database.close();
      }
    });
  });

  it('取图协议反查—候选仅落盘行命中—资产版本路径按内容寻址派生', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'media_repo_media_lookup.sqlite');
      try {
        const unitOfWork = new SqliteMediaUnitOfWork(database, () => NOW);
        await seedSucceededCandidate(unitOfWork, 'cand_stored', hash64('stored'));
        // 未落盘候选（PENDING）不命中。
        await unitOfWork.run((media) =>
          media.insertCandidates({
            candidateIds: ['cand_pending'],
            generationInputHash: hash64('pending'),
            modelId: MODEL_ID,
            projectId: 'project_media',
            roundNo: 2,
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        await expect(
          unitOfWork.run((media) => media.findCandidateMediaById('cand_stored')),
        ).resolves.toEqual({
          byteSize: 1024,
          mimeType: 'image/png',
          storageRelPath: `projects/project_media/images/ff/${'f'.repeat(64)}.png`,
        });
        await expect(
          unitOfWork.run((media) => media.findCandidateMediaById('cand_pending')),
        ).resolves.toBeNull();
        await expect(
          unitOfWork.run((media) => media.findCandidateMediaById('cand_unknown')),
        ).resolves.toBeNull();

        await unitOfWork.run((media) =>
          media.createAsset({
            assetType: 'SCENE',
            bibleRefId: 'scene_media_lookup',
            displayName: '雨巷',
            id: 'asset_lookup',
            projectId: 'project_media',
          }),
        );
        await unitOfWork.run((media) =>
          media.appendAssetVersion({
            assetId: 'asset_lookup',
            byteSize: 2048,
            fileSha256: 'a'.repeat(64),
            id: 'version_lookup',
            mimeType: 'image/webp',
          }),
        );
        await expect(
          unitOfWork.run((media) => media.findAssetVersionMediaById('version_lookup')),
        ).resolves.toEqual({
          byteSize: 2048,
          mimeType: 'image/webp',
          storageRelPath: `projects/project_media/assets/aa/${'a'.repeat(64)}.webp`,
        });
        await expect(
          unitOfWork.run((media) => media.findAssetVersionMediaById('version_missing')),
        ).resolves.toBeNull();
      } finally {
        database.close();
      }
    });
  });
});

const seedSucceededCandidate = async (
  unitOfWork: SqliteMediaUnitOfWork,
  candidateId: string,
  generationInputHash: string,
  shotId = 'shot_media',
  shotVersionId = 'shotv_media',
  roundNo = 1,
): Promise<void> => {
  await unitOfWork.run(async (media) => {
    await media.insertCandidates({
      candidateIds: [candidateId],
      generationInputHash,
      modelId: MODEL_ID,
      projectId: 'project_media',
      roundNo,
      shotId,
      shotVersionId,
    });
    await media.completeCandidateSucceeded(candidateId, {
      byteSize: 1024,
      fileSha256: 'f'.repeat(64),
      height: 64,
      invocationEvidenceRef: `invocation_${candidateId}`,
      mimeType: 'image/png',
      storageRelPath: `projects/project_media/images/ff/${'f'.repeat(64)}.png`,
      width: 64,
    });
  });
};

const selectedRows = (
  database: SqliteTestDatabase,
  shotId: string,
): readonly { readonly id: string; readonly selected_by_context: string }[] =>
  database
    .prepare(
      'SELECT id, selected_by_context FROM image_candidates WHERE shot_id = ? AND selected_at IS NOT NULL',
    )
    .all(shotId) as unknown as readonly { id: string; selected_by_context: string }[];
