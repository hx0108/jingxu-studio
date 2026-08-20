import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteMediaUnitOfWork } from './sqlite-media-unit-of-work';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-16T00:00:00.000Z';
const VIDEO_MODEL_ID = 'doubao-seedance-1-0-lite-i2v-250428';
const IMAGE_MODEL_ID = 'doubao-seedream-5-0-lite-260128';

/** 0012/0009 CHECK 要求 generation_input_hash/file_sha256 为 64 位定长；按前缀展开。 */
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

/**
 * 经聚合内 image 仓储落一枚已选中首帧候选（跨域同事务可见性同时被本路径验证），
 * 返回其 (candidateId, fileSha256)。
 */
const seedSelectedFirstFrame = async (
  unitOfWork: SqliteMediaUnitOfWork,
  candidateId: string,
  fileSha256: string,
): Promise<void> => {
  await unitOfWork.run(({ media }) =>
    media.insertCandidates({
      candidateIds: [candidateId],
      generationInputHash: hash64(`img_${candidateId}`),
      modelId: IMAGE_MODEL_ID,
      projectId: 'project_media',
      roundNo: 1,
      shotId: 'shot_media',
      shotVersionId: 'shotv_media',
    }),
  );
  await unitOfWork.run(({ media }) =>
    media.completeCandidateSucceeded(candidateId, {
      byteSize: 1024,
      fileSha256,
      height: 2560,
      invocationEvidenceRef: 'invocation_img_1',
      mimeType: 'image/png',
      storageRelPath: `images/${fileSha256.slice(0, 2)}/${fileSha256}.png`,
      width: 1440,
    }),
  );
  await unitOfWork.run(({ media }) => media.selectCandidate('shot_media', candidateId));
};

describe('SqliteVideoMediaRepository（聚合 { media, invocations, video }）', () => {
  it('建档到终态闭环—首帧锚点/时长口径/幂等冲突/跨项目不可见', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'video_repo_lifecycle.sqlite');
      try {
        const unitOfWork = new SqliteMediaUnitOfWork(database, () => NOW);
        const firstFrameSha = hash64('firstframe_1');
        await seedSelectedFirstFrame(unitOfWork, 'img_candidate_1', firstFrameSha);

        const task = await unitOfWork.run(({ video }) =>
          video.insertTask({
            candidateCount: 3,
            generationInputHash: hash64('video_gen_1'),
            id: 'video_task_1',
            idempotencyKey: 'video-idem_1',
            projectId: 'project_media',
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        expect(task.phase).toBe('SUBMITTED');
        expect(task.roundNo).toBe(1);
        // 幂等重放查询命中；重复建档与同镜头并发建档由 UNIQUE 兜底。
        await expect(
          unitOfWork.run(({ video }) =>
            video.findTaskByIdempotencyKey('project_media', 'video-idem_1'),
          ),
        ).resolves.toMatchObject({ id: 'video_task_1' });
        await expect(
          unitOfWork.run(({ video }) =>
            video.insertTask({
              candidateCount: 2,
              generationInputHash: hash64('video_gen_1b'),
              id: 'video_task_dup',
              idempotencyKey: 'video-idem_1',
              projectId: 'project_media',
              shotId: 'shot_media',
              shotVersionId: 'shotv_media',
            }),
          ),
        ).rejects.toThrow('MEDIA_TASK_IDEMPOTENCY_CONFLICT');
        const candidates = await unitOfWork.run(({ video }) =>
          video.insertCandidates({
            candidateIds: ['video_candidate_1', 'video_candidate_2', 'video_candidate_3'],
            firstFrameCandidateId: 'img_candidate_1',
            firstFrameFileSha256: firstFrameSha,
            generationInputHash: hash64('video_gen_1'),
            modelId: VIDEO_MODEL_ID,
            projectId: 'project_media',
            requestedDurationSec: 5,
            roundNo: task.roundNo,
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        expect(
          candidates.map(({ id, indexInRound, status }) => ({ id, indexInRound, status })),
        ).toEqual([
          { id: 'video_candidate_1', indexInRound: 0, status: 'PENDING' },
          { id: 'video_candidate_2', indexInRound: 1, status: 'PENDING' },
          { id: 'video_candidate_3', indexInRound: 2, status: 'PENDING' },
        ]);
        // 新 idempotencyKey 同镜头 → 新一轮（round_no 自候选轮 max+1 派生）。
        const roundTwo = await unitOfWork.run(({ video }) =>
          video.insertTask({
            candidateCount: 1,
            generationInputHash: hash64('video_gen_2'),
            id: 'video_task_round2',
            idempotencyKey: 'video-idem_2',
            projectId: 'project_media',
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        expect(roundTwo.roundNo).toBe(2);
        // 首帧必须指向真实 image_candidates 行（FK）。
        await expect(
          unitOfWork.run(({ video }) =>
            video.insertCandidates({
              candidateIds: ['video_candidate_bad'],
              firstFrameCandidateId: 'missing_first_frame',
              firstFrameFileSha256: firstFrameSha,
              generationInputHash: hash64('video_gen_bad'),
              modelId: VIDEO_MODEL_ID,
              projectId: 'project_media',
              requestedDurationSec: 5,
              roundNo: 9,
              shotId: 'shot_media',
              shotVersionId: 'shotv_media',
            }),
          ),
        ).rejects.toThrow();

        await unitOfWork.run(({ video }) =>
          video.assignCandidateProviderTask('video_candidate_1', 'seedance-task-001'),
        );
        const succeeded = await unitOfWork.run(({ video }) =>
          video.completeCandidateSucceeded('video_candidate_1', {
            actualDurationSec: 5,
            byteSize: 1868,
            fileSha256: hash64('video_bytes_1'),
            height: 720,
            invocationEvidenceRef: 'invocation_video_1',
            mimeType: 'video/mp4',
            storageRelPath: 'videos/v1/v1.mp4',
            width: 1280,
          }),
        );
        expect(succeeded).toMatchObject({
          actualDurationSec: 5,
          fileSha256: hash64('video_bytes_1'),
          firstFrameCandidateId: 'img_candidate_1',
          firstFrameFileSha256: firstFrameSha,
          providerTaskId: 'seedance-task-001',
          requestedDurationSec: 5,
          status: 'SUCCEEDED',
        });
        // 未回报 actual_duration_sec → null 如实（不估算）。
        const noActual = await unitOfWork.run(({ video }) =>
          video.completeCandidateSucceeded('video_candidate_2', {
            byteSize: 1868,
            fileSha256: hash64('video_bytes_2'),
            height: 720,
            invocationEvidenceRef: 'invocation_video_2',
            mimeType: 'video/mp4',
            storageRelPath: 'videos/v2/v2.mp4',
            width: 1280,
          }),
        );
        expect(noActual).toMatchObject({ actualDurationSec: null, status: 'SUCCEEDED' });
        const failed = await unitOfWork.run(({ video }) =>
          video.completeCandidateFailed('video_candidate_3', {
            errorCode: 'MODEL_TIMEOUT',
            invocationEvidenceRef: 'invocation_video_3',
          }),
        );
        expect(failed).toMatchObject({ errorCode: 'MODEL_TIMEOUT', status: 'FAILED' });
        // 守卫：非 PENDING 候选二次终态为 no-op（竞态下原样返回，不可再覆盖）。
        const replayed = await unitOfWork.run(({ video }) =>
          video.completeCandidateFailed('video_candidate_3', {
            errorCode: 'MODEL_PROVIDER_ERROR',
            invocationEvidenceRef: 'invocation_video_3b',
          }),
        );
        expect(replayed.errorCode).toBe('MODEL_TIMEOUT');

        const listed = await unitOfWork.run(({ video }) => video.listCandidates('shot_media'));
        expect(listed.map(({ id, status }) => ({ id, status }))).toEqual([
          { id: 'video_candidate_1', status: 'SUCCEEDED' },
          { id: 'video_candidate_2', status: 'SUCCEEDED' },
          { id: 'video_candidate_3', status: 'FAILED' },
        ]);
        // 跨项目不可见 + /video-candidate 协议入口（PENDING/FAILED/未知 → null）。
        await expect(
          unitOfWork.run(({ video }) =>
            video.findCandidateById('other_project', 'video_candidate_1'),
          ),
        ).resolves.toBeNull();
        await expect(
          unitOfWork.run(({ video }) => video.findCandidateMediaById('video_candidate_1')),
        ).resolves.toEqual({
          byteSize: 1868,
          mimeType: 'video/mp4',
          storageRelPath: 'videos/v1/v1.mp4',
        });
        await expect(
          unitOfWork.run(({ video }) => video.findCandidateMediaById('video_candidate_3')),
        ).resolves.toBeNull();
        await expect(
          unitOfWork.run(({ video }) => video.findCandidateMediaById('missing')),
        ).resolves.toBeNull();

        // 任务相位机：POLLING→DOWNLOADING→COMPLETED；终态后拒绝转移。
        await unitOfWork.run(({ video }) =>
          video.markTaskPolling('video_task_1', 'seedance-task-001'),
        );
        await unitOfWork.run(({ video }) => video.markTaskDownloading('video_task_1'));
        await expect(
          unitOfWork.run(({ video }) => video.completeTask('video_task_1')),
        ).resolves.toMatchObject({ phase: 'COMPLETED' });
        await expect(
          unitOfWork.run(({ video }) => video.cancelTask('video_task_1')),
        ).rejects.toThrow('MEDIA_TASK_ALREADY_TERMINAL');
        // round2 任务走 CANCELLED 终态（非终态扫描前收口）。
        await expect(
          unitOfWork.run(({ video }) => video.cancelTask('video_task_round2')),
        ).resolves.toMatchObject({ phase: 'CANCELLED' });
        await expect(
          unitOfWork.run(({ video }) => video.listUnfinishedTasks('project_media')),
        ).resolves.toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('选择指针—仅 SUCCEEDED 可选、同镜头唯一、改选清旧设新', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'video_repo_select.sqlite');
      try {
        const unitOfWork = new SqliteMediaUnitOfWork(database, () => NOW);
        await seedSelectedFirstFrame(unitOfWork, 'img_candidate_1', hash64('firstframe_1'));
        await unitOfWork.run(({ video }) =>
          video.insertCandidates({
            candidateIds: ['video_pending', 'video_ok_1', 'video_ok_2'],
            firstFrameCandidateId: 'img_candidate_1',
            firstFrameFileSha256: hash64('firstframe_1'),
            generationInputHash: hash64('video_gen_select'),
            modelId: VIDEO_MODEL_ID,
            projectId: 'project_media',
            requestedDurationSec: 5,
            roundNo: 1,
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        await expect(
          unitOfWork.run(({ video }) => video.selectCandidate('shot_media', 'video_pending')),
        ).rejects.toThrow('MEDIA_CANDIDATE_NOT_SELECTABLE');
        await expect(
          unitOfWork.run(({ video }) => video.selectCandidate('shot_media', 'missing')),
        ).rejects.toThrow('MEDIA_CANDIDATE_NOT_FOUND');
        for (const id of ['video_ok_1', 'video_ok_2']) {
          await unitOfWork.run(({ video }) =>
            video.completeCandidateSucceeded(id, {
              byteSize: 1868,
              fileSha256: hash64(`video_bytes_${id}`),
              height: 720,
              invocationEvidenceRef: `invocation_${id}`,
              mimeType: 'video/mp4',
              storageRelPath: `videos/${id.slice(-2)}/${id}.mp4`,
              width: 1280,
            }),
          );
        }
        await unitOfWork.run(({ video }) => video.selectCandidate('shot_media', 'video_ok_1'));
        await unitOfWork.run(({ video }) => video.selectCandidate('shot_media', 'video_ok_2'));
        const selected = await unitOfWork.run(({ video }) => video.listCandidates('shot_media'));
        expect(
          selected.filter(({ selectedAt }) => selectedAt !== null).map(({ id }) => id),
        ).toEqual(['video_ok_2']);
      } finally {
        database.close();
      }
    });
  });

  it('STALE 双触发—shotVersion/世代哈希/首帧改选 join；图片域不受扰动', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'video_repo_stale.sqlite');
      try {
        const unitOfWork = new SqliteMediaUnitOfWork(database, () => NOW);
        const firstFrameSha = hash64('firstframe_1');
        await seedSelectedFirstFrame(unitOfWork, 'img_candidate_1', firstFrameSha);
        await unitOfWork.run(({ video }) =>
          video.insertCandidates({
            candidateIds: ['video_a1', 'video_a2'],
            firstFrameCandidateId: 'img_candidate_1',
            firstFrameFileSha256: firstFrameSha,
            generationInputHash: hash64('video_gen_a'),
            modelId: VIDEO_MODEL_ID,
            projectId: 'project_media',
            requestedDurationSec: 5,
            roundNo: 1,
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        for (const id of ['video_a1', 'video_a2']) {
          await unitOfWork.run(({ video }) =>
            video.completeCandidateSucceeded(id, {
              byteSize: 1868,
              fileSha256: hash64(`bytes_${id}`),
              height: 720,
              invocationEvidenceRef: `invocation_${id}`,
              mimeType: 'video/mp4',
              storageRelPath: `videos/${id}/${id}.mp4`,
              width: 1280,
            }),
          );
        }

        // 触发①：镜头新版本确认 → 按 shotVersionId 传播（图片候选不受扰动）。
        const byVersion = await unitOfWork.run(({ video }) =>
          video.markCandidatesStaleByShotVersion('shotv_media'),
        );
        expect(byVersion).toEqual([{ candidateCount: 2, shotId: 'shot_media' }]);
        const staled = await unitOfWork.run(({ video }) => video.listCandidates('shot_media'));
        expect(staled.every(({ status }) => status === 'STALE_INPUT')).toBe(true);
        // STALE 行保留文件四元组（可追溯）。
        expect(staled[0]?.fileSha256).toBe(hash64('bytes_video_a1'));
        const images = await unitOfWork.run(({ media }) => media.listCandidates('shot_media'));
        expect(images[0]?.status).toBe('SUCCEEDED');
        // 已 STALE 行不重复计数（幂等）。
        await expect(
          unitOfWork.run(({ video }) => video.markCandidatesStaleByShotVersion('shotv_media')),
        ).resolves.toEqual([]);

        // 触发②：首帧改选。先以旧锚点再落一轮 SUCCEEDED 候选（模拟改选前生成完成）。
        const secondFrameSha = hash64('firstframe_2');
        await unitOfWork.run(({ video }) =>
          video.insertCandidates({
            candidateIds: ['video_b1'],
            firstFrameCandidateId: 'img_candidate_1',
            firstFrameFileSha256: firstFrameSha,
            generationInputHash: hash64('video_gen_b'),
            modelId: VIDEO_MODEL_ID,
            projectId: 'project_media',
            requestedDurationSec: 10,
            roundNo: 2,
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        await unitOfWork.run(({ video }) =>
          video.completeCandidateSucceeded('video_b1', {
            byteSize: 1868,
            fileSha256: hash64('bytes_video_b1'),
            height: 720,
            invocationEvidenceRef: 'invocation_video_b1',
            mimeType: 'video/mp4',
            storageRelPath: 'videos/b1/b1.mp4',
            width: 1280,
          }),
        );
        // 图片域改选到不同 sha 的首帧。
        await unitOfWork.run(({ media }) =>
          media.insertCandidates({
            candidateIds: ['img_candidate_2'],
            generationInputHash: hash64('img_gen_2'),
            modelId: IMAGE_MODEL_ID,
            projectId: 'project_media',
            roundNo: 2,
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        await unitOfWork.run(({ media }) =>
          media.completeCandidateSucceeded('img_candidate_2', {
            byteSize: 1024,
            fileSha256: secondFrameSha,
            height: 2560,
            invocationEvidenceRef: 'invocation_img_2',
            mimeType: 'image/png',
            storageRelPath: `images/${secondFrameSha.slice(0, 2)}/x.png`,
            width: 1440,
          }),
        );
        await unitOfWork.run(({ media }) => media.selectCandidate('shot_media', 'img_candidate_2'));

        // 旧锚点 SUCCEEDED 候选置 STALE；已 STALE 行不重复计数；图片域不受扰动。
        const byFrameChange = await unitOfWork.run(({ video }) =>
          video.markVideoStaleByFirstFrameChange('shot_media'),
        );
        expect(byFrameChange).toEqual([{ candidateCount: 1, shotId: 'shot_media' }]);
        const imagesAfter = await unitOfWork.run(({ media }) => media.listCandidates('shot_media'));
        expect(imagesAfter.map(({ id, status }) => ({ id, status }))).toEqual([
          { id: 'img_candidate_1', status: 'SUCCEEDED' },
          { id: 'img_candidate_2', status: 'SUCCEEDED' },
        ]);

        // 以新首帧建档 PENDING 候选：锚点与当前选择一致 → join 判定不受影响。
        await unitOfWork.run(({ video }) =>
          video.insertCandidates({
            candidateIds: ['video_c1'],
            firstFrameCandidateId: 'img_candidate_2',
            firstFrameFileSha256: secondFrameSha,
            generationInputHash: hash64('video_gen_c'),
            modelId: VIDEO_MODEL_ID,
            projectId: 'project_media',
            requestedDurationSec: 5,
            roundNo: 3,
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        await expect(
          unitOfWork.run(({ video }) => video.markVideoStaleByFirstFrameChange('shot_media')),
        ).resolves.toEqual([]);

        // 触发①'：世代哈希传播（video 表内，按 generation_input_hash 定位）。
        const byHash = await unitOfWork.run(({ video }) =>
          video.markCandidatesStaleByGenerationInputHash(hash64('video_gen_c')),
        );
        expect(byHash).toEqual([{ candidateCount: 1, shotId: 'shot_media' }]);

        // 清除首帧选择（锚点缺失）→ 全部可传播候选 STALE。
        await unitOfWork.run(({ video }) =>
          video.insertCandidates({
            candidateIds: ['video_d1'],
            firstFrameCandidateId: 'img_candidate_2',
            firstFrameFileSha256: secondFrameSha,
            generationInputHash: hash64('video_gen_d'),
            modelId: VIDEO_MODEL_ID,
            projectId: 'project_media',
            requestedDurationSec: 5,
            roundNo: 4,
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        database
          .prepare("UPDATE image_candidates SET selected_at = NULL WHERE shot_id = 'shot_media'")
          .run();
        await expect(
          unitOfWork.run(({ video }) => video.markVideoStaleByFirstFrameChange('shot_media')),
        ).resolves.toEqual([{ candidateCount: 1, shotId: 'shot_media' }]);
      } finally {
        database.close();
      }
    });
  });

  it('批次族—惰性消费/收尾派生/取消/成员聚合与世代底座', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'video_repo_batch.sqlite');
      try {
        insertShot(database, 'shot_second', 'shotv_second');
        const unitOfWork = new SqliteMediaUnitOfWork(database, () => NOW);
        await seedSelectedFirstFrame(unitOfWork, 'img_candidate_1', hash64('firstframe_1'));

        const batch = await unitOfWork.run(({ video }) =>
          video.insertBatch({
            id: 'video_batch_1',
            idempotencyKey: 'video-batch_i1',
            projectId: 'project_media',
            skippedShotIds: ['shot_skipped'],
            targetShotIds: ['shot_media', 'shot_second'],
          }),
        );
        expect(batch).toMatchObject({
          pendingShotIds: ['shot_media', 'shot_second'],
          skippedShotIds: ['shot_skipped'],
          status: 'RUNNING',
        });
        await expect(
          unitOfWork.run(({ video }) =>
            video.insertBatch({
              id: 'video_batch_dup',
              idempotencyKey: 'video-batch_i1',
              projectId: 'project_media',
              skippedShotIds: [],
              targetShotIds: [],
            }),
          ),
        ).rejects.toThrow('MEDIA_BATCH_IDEMPOTENCY_CONFLICT');
        await expect(
          unitOfWork.run(({ video }) => video.findRunningBatchByProject('project_media')),
        ).resolves.toMatchObject({ id: 'video_batch_1' });
        await expect(
          unitOfWork.run(({ video }) => video.listRunningBatchProjectIds()),
        ).resolves.toEqual(['project_media']);

        await expect(
          unitOfWork.run(({ video }) => video.takeNextPendingShot('video_batch_1')),
        ).resolves.toBe('shot_media');
        await expect(
          unitOfWork.run(({ video }) => video.takeNextPendingShot('video_batch_1')),
        ).resolves.toBe('shot_second');
        await expect(
          unitOfWork.run(({ video }) => video.takeNextPendingShot('video_batch_1')),
        ).resolves.toBeNull();

        const member = await unitOfWork.run(({ video }) =>
          video.insertTask({
            batchId: 'video_batch_1',
            candidateCount: 2,
            generationInputHash: hash64('video_gen_batch'),
            id: 'video_task_member',
            idempotencyKey: 'video-idem_member',
            projectId: 'project_media',
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        await unitOfWork.run(({ video }) =>
          video.insertCandidates({
            candidateIds: ['video_batch_c1', 'video_batch_c2'],
            firstFrameCandidateId: 'img_candidate_1',
            firstFrameFileSha256: hash64('firstframe_1'),
            generationInputHash: hash64('video_gen_batch'),
            modelId: VIDEO_MODEL_ID,
            projectId: 'project_media',
            requestedDurationSec: 5,
            roundNo: member.roundNo,
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          }),
        );
        await unitOfWork.run(({ video }) =>
          video.completeCandidateSucceeded('video_batch_c1', {
            byteSize: 1868,
            fileSha256: hash64('bytes_batch_1'),
            height: 720,
            invocationEvidenceRef: 'invocation_batch_1',
            mimeType: 'video/mp4',
            storageRelPath: 'videos/b1/b1.mp4',
            width: 1280,
          }),
        );
        await unitOfWork.run(({ video }) => video.completeTask('video_task_member'));
        await expect(
          unitOfWork.run(({ video }) => video.countUnfinishedBatchTasks('video_batch_1')),
        ).resolves.toBe(0);
        await expect(
          unitOfWork.run(({ video }) => video.listBatchMemberTasks('video_batch_1')),
        ).resolves.toHaveLength(1);

        // 收尾派生：队列耗尽且无失败成员 → COMPLETED。
        await expect(
          unitOfWork.run(({ video }) => video.finalizeBatch('video_batch_1')),
        ).resolves.toMatchObject({ status: 'COMPLETED' });
        await expect(
          unitOfWork.run(({ video }) => video.finalizeBatch('video_batch_1')),
        ).rejects.toThrow('MEDIA_BATCH_ALREADY_TERMINAL');

        // 第二批制造失败成员（COMPLETED 但同轮零 SUCCEEDED）→ PARTIAL_COMPLETED。
        await unitOfWork.run(({ video }) =>
          video.insertBatch({
            id: 'video_batch_2',
            idempotencyKey: 'video-batch_i2',
            projectId: 'project_media',
            skippedShotIds: [],
            targetShotIds: ['shot_second'],
          }),
        );
        const memberTwo = await unitOfWork.run(({ video }) =>
          video.insertTask({
            batchId: 'video_batch_2',
            candidateCount: 1,
            generationInputHash: hash64('video_gen_b2'),
            id: 'video_task_member_2',
            idempotencyKey: 'video-idem_member_2',
            projectId: 'project_media',
            shotId: 'shot_second',
            shotVersionId: 'shotv_second',
          }),
        );
        await unitOfWork.run(({ video }) =>
          video.insertCandidates({
            candidateIds: ['video_b2_c1'],
            firstFrameCandidateId: 'img_candidate_1',
            firstFrameFileSha256: hash64('firstframe_1'),
            generationInputHash: hash64('video_gen_b2'),
            modelId: VIDEO_MODEL_ID,
            projectId: 'project_media',
            requestedDurationSec: 5,
            roundNo: memberTwo.roundNo,
            shotId: 'shot_second',
            shotVersionId: 'shotv_second',
          }),
        );
        await unitOfWork.run(({ video }) =>
          video.completeCandidateFailed('video_b2_c1', {
            errorCode: 'MODEL_CONTENT_REJECTED',
            invocationEvidenceRef: 'invocation_b2_1',
          }),
        );
        await unitOfWork.run(({ video }) => video.completeTask('video_task_member_2'));
        // 耗尽批次二队列——PARTIAL 由「零 SUCCEEDED 成员」派生而非剩余队列。
        await expect(
          unitOfWork.run(({ video }) => video.takeNextPendingShot('video_batch_2')),
        ).resolves.toBe('shot_second');
        await expect(
          unitOfWork.run(({ video }) => video.finalizeBatch('video_batch_2')),
        ).resolves.toMatchObject({ status: 'PARTIAL_COMPLETED' });
        // 取消语义：RUNNING→CANCELLED 剩余队列保留；已终态幂等返回现状。
        const cancelled = await unitOfWork.run(({ video }) =>
          video.insertBatch({
            id: 'video_batch_3',
            idempotencyKey: 'video-batch_i3',
            projectId: 'project_media',
            skippedShotIds: [],
            targetShotIds: ['shot_media', 'shot_second'],
          }),
        );
        expect(cancelled.pendingShotIds).toEqual(['shot_media', 'shot_second']);
        await unitOfWork.run(({ video }) => video.takeNextPendingShot('video_batch_3'));
        await expect(
          unitOfWork.run(({ video }) => video.cancelBatch('video_batch_3')),
        ).resolves.toMatchObject({ pendingShotIds: ['shot_second'], status: 'CANCELLED' });
        await expect(
          unitOfWork.run(({ video }) => video.cancelBatch('video_batch_3')),
        ).resolves.toMatchObject({ status: 'CANCELLED' });
        await expect(
          unitOfWork.run(({ video }) => video.listBatchesByProject('project_media', 10)),
        ).resolves.toMatchObject([
          { id: 'video_batch_3' },
          { id: 'video_batch_2' },
          { id: 'video_batch_1' },
        ]);

        // 世代底座：SUCCEEDED 候选按 (shot, hash) 聚合；每镜头最新任务。
        const shotHashes = await unitOfWork.run(({ video }) =>
          video.listSucceededCandidateShotHashes('project_media'),
        );
        expect(shotHashes).toEqual([
          {
            generationInputHash: hash64('video_gen_batch'),
            succeededCount: 1,
            shotId: 'shot_media',
          },
        ]);
        const latestTasks = await unitOfWork.run(({ video }) =>
          video.listLatestTaskPerShot('project_media'),
        );
        expect(latestTasks.map(({ shotId }) => shotId).sort()).toEqual([
          'shot_media',
          'shot_second',
        ]);
      } finally {
        database.close();
      }
    });
  });

  it('聚合事务边界—跨域写同事务原子提交、work 抛出全域回滚', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'video_repo_uow.sqlite');
      try {
        const unitOfWork = new SqliteMediaUnitOfWork(database, () => NOW);
        const firstFrameSha = hash64('firstframe_1');
        await seedSelectedFirstFrame(unitOfWork, 'img_candidate_1', firstFrameSha);
        // 单事务内：视频建档 + 首帧跨域读（markVideoStaleByFirstFrameChange 的 join
        // 读 image_candidates 选中行）+ 图片域写——同一 BEGIN IMMEDIATE 边界。
        await unitOfWork.run(async ({ video }) => {
          const task = await video.insertTask({
            candidateCount: 1,
            generationInputHash: hash64('video_gen_uow'),
            id: 'video_task_uow',
            idempotencyKey: 'video-idem_uow',
            projectId: 'project_media',
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          });
          await video.insertCandidates({
            candidateIds: ['video_uow_c1'],
            firstFrameCandidateId: 'img_candidate_1',
            firstFrameFileSha256: firstFrameSha,
            generationInputHash: hash64('video_gen_uow'),
            modelId: VIDEO_MODEL_ID,
            projectId: 'project_media',
            requestedDurationSec: 5,
            roundNo: task.roundNo,
            shotId: 'shot_media',
            shotVersionId: 'shotv_media',
          });
          const affected = await video.markVideoStaleByFirstFrameChange('shot_media');
          expect(affected).toEqual([]); // 锚点与当前选择一致
        });
        // work 抛出 → 视频与图片两域写入一并回滚。
        await expect(
          unitOfWork.run(async ({ media, video }) => {
            await video.insertBatch({
              id: 'video_batch_rollback',
              idempotencyKey: 'video-batch_rb',
              projectId: 'project_media',
              skippedShotIds: [],
              targetShotIds: ['shot_media'],
            });
            await media.insertCandidates({
              candidateIds: ['img_rollback_1'],
              generationInputHash: hash64('img_rollback'),
              modelId: IMAGE_MODEL_ID,
              projectId: 'project_media',
              roundNo: 3,
              shotId: 'shot_media',
              shotVersionId: 'shotv_media',
            });
            throw new Error('INJECTED_FAILURE');
          }),
        ).rejects.toThrow('INJECTED_FAILURE');
        await expect(
          unitOfWork.run(({ video }) =>
            video.findBatchById('project_media', 'video_batch_rollback'),
          ),
        ).resolves.toBeNull();
        const imagesAfterRollback = await unitOfWork.run(({ media }) =>
          media.listCandidates('shot_media'),
        );
        expect(imagesAfterRollback.map(({ id }) => id)).toEqual(['img_candidate_1']);
      } finally {
        database.close();
      }
    });
  });
});
