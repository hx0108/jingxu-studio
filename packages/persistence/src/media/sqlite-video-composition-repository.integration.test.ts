import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { SqliteMediaUnitOfWork } from './sqlite-media-unit-of-work';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-24T00:00:00.000Z';
const HASH = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const seedGraph = (database: SqliteTestDatabase): void => {
  database
    .prepare(
      `INSERT INTO projects
    (id,name,creation_mode,dialogue_render_mode,deployment_mode,data_root_rel,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      'project_1',
      'V2',
      'AI_ORIGINAL',
      'NARRATION_FIRST',
      'LOCAL_DEMO',
      'projects/project_1',
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO format_profiles
    (id,project_id,version_no,aspect_ratio,width,height,fps,language,subtitle_safe_area_json,is_current,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run('format_1', 'project_1', 1, '9:16', 1080, 1920, 24, 'zh-CN', '{}', 1, NOW);
  database
    .prepare(
      `INSERT INTO episodes (id,project_id,title,target_duration_sec,created_at,updated_at)
    VALUES (?,?,?,?,?,?)`,
    )
    .run('episode_1', 'project_1', '第一集', 90, NOW, NOW);
  database
    .prepare(
      `INSERT INTO story_bible_versions
    (id,project_id,version_no,document_json,document_sha256,status,source,created_at)
    VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run('bible_1', 'project_1', 1, '{}', HASH, 'READY', 'USER', NOW);
  database
    .prepare(
      `INSERT INTO episode_versions
    (id,episode_id,version_no,story_bible_version_id,format_profile_id,target_duration_sec,shot_set_hash,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run('episode_v1', 'episode_1', 1, 'bible_1', 'format_1', 90, HASH, 'READY', NOW);
  database
    .prepare(
      `INSERT INTO shots (id,episode_id,lifecycle_status,created_at,updated_at)
    VALUES (?,?,?,?,?)`,
    )
    .run('shot_1', 'episode_1', 'ACTIVE', NOW, NOW);
  const document = JSON.stringify({
    contract_version: 1,
    dialogue: { dialogue_render_mode: 'NARRATION_FIRST' },
    format_profile_id: 'format_1',
    parent_version_id: null,
    sequence: 1,
    shot_id: 'shot_1',
    status: 'READY',
    target_duration_sec: 5,
    version_id: 'shot_v1',
  });
  database
    .prepare(
      `INSERT INTO shot_contract_versions
    (id,shot_id,version_no,lineage_resolution_status,sequence,version_status,format_profile_id,target_duration_sec,dialogue_render_mode,document_json,document_sha256,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'shot_v1',
      'shot_1',
      1,
      'ROOT',
      1,
      'READY',
      'format_1',
      5,
      'NARRATION_FIRST',
      document,
      HASH,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO image_candidates
    (id,project_id,shot_id,shot_version_id,round_no,index_in_round,generation_input_hash,status,model_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run('image_1', 'project_1', 'shot_1', 'shot_v1', 1, 0, HASH, 'PENDING', 'mock', NOW, NOW);
  database
    .prepare(
      `INSERT INTO video_candidates
    (id,project_id,shot_id,shot_version_id,round_no,index_in_round,generation_input_hash,status,file_sha256,byte_size,mime_type,width,height,storage_rel_path,model_id,invocation_evidence_ref,requested_duration_sec,actual_duration_sec,first_frame_candidate_id,first_frame_file_sha256,selected_at,selected_by_context,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'video_1',
      'project_1',
      'shot_1',
      'shot_v1',
      1,
      0,
      HASH,
      'SUCCEEDED',
      HASH,
      100,
      'video/mp4',
      48,
      48,
      `projects/project_1/videos/aa/${HASH}.mp4`,
      'mock',
      'invocation_1',
      5,
      5,
      'image_1',
      HASH,
      NOW,
      'USER',
      NOW,
      NOW,
    );
};

const timelineItem = (trimOutMs = 5_000) => ({
  candidateId: 'video_1',
  enabled: true,
  fileSha256: HASH,
  generationInputHash: HASH,
  position: 0,
  shotId: 'shot_1',
  trimInMs: 0,
  trimOutMs,
});

const requireValue = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined)
    throw new Error('VIDEO_COMPOSITION_REPOSITORY_MISSING');
  return value;
};

describe('SqliteVideoCompositionRepository/UoW', () => {
  it('时间线更新创建不可变子版本，旧版本与 current pointer 保持正确', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = new SqliteTestDatabase(path.join(root, 'composition.sqlite'));
      try {
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        seedGraph(database);
        const uow = new SqliteMediaUnitOfWork(database, () => NOW);
        const first = await uow.run(({ composition }) =>
          requireValue(composition).composition.createTimeline({
            episodeId: 'episode_1',
            episodeVersionId: 'episode_v1',
            formatProfileId: 'format_1',
            id: 'timeline_v1',
            inputHash: HASH,
            items: [timelineItem()],
            projectId: 'project_1',
            totalDurationMs: 5_000,
          }),
        );
        const second = await uow.run(({ composition }) =>
          requireValue(composition).composition.updateTimeline({
            audioAssetId: null,
            expectedVersionId: first.id,
            id: 'timeline_v2',
            inputHash: HASH_B,
            items: [timelineItem(4_000)],
            projectId: 'project_1',
            totalDurationMs: 4_000,
          }),
        );
        const old = await uow.run(({ composition }) =>
          requireValue(composition).composition.findTimelineVersion(
            'project_1',
            'episode_1',
            'timeline_v1',
          ),
        );
        const current = await uow.run(({ composition }) =>
          requireValue(composition).composition.findTimelineVersion('project_1', 'episode_1', null),
        );
        expect(old).toMatchObject({
          id: 'timeline_v1',
          parentVersionId: null,
          totalDurationMs: 5_000,
          versionNo: 1,
        });
        expect(second).toMatchObject({
          id: 'timeline_v2',
          parentVersionId: 'timeline_v1',
          totalDurationMs: 4_000,
          versionNo: 2,
        });
        expect(current?.id).toBe('timeline_v2');
      } finally {
        database.close();
      }
    });
  });

  it('同 requestId 由唯一约束保持单一 Job，UoW 异常整单回滚', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = new SqliteTestDatabase(path.join(root, 'rollback.sqlite'));
      try {
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        seedGraph(database);
        const uow = new SqliteMediaUnitOfWork(database, () => NOW);
        await uow.run(({ composition }) =>
          requireValue(composition).composition.createTimeline({
            episodeId: 'episode_1',
            episodeVersionId: 'episode_v1',
            formatProfileId: 'format_1',
            id: 'timeline_v1',
            inputHash: HASH,
            items: [timelineItem()],
            projectId: 'project_1',
            totalDurationMs: 5_000,
          }),
        );
        await uow.run(({ composition }) =>
          requireValue(composition).composition.createExportJob({
            episodeId: 'episode_1',
            id: 'export_1',
            inputHash: HASH,
            projectId: 'project_1',
            requestId: 'request_1',
            timelineVersionId: 'timeline_v1',
            totalDurationMs: 5_000,
          }),
        );
        const cancelled = await uow.run(({ composition }) =>
          requireValue(composition).composition.updateExportStatus(
            'export_1',
            'CANCELLED',
            'VIDEO_EXPORT_CANCELLED',
          ),
        );
        const lateCallback = await uow.run(({ composition }) =>
          requireValue(composition).composition.updateExportStatus(
            'export_1',
            'CANCELLED',
            'AbortError',
          ),
        );
        expect(cancelled.errorCode).toBe('VIDEO_EXPORT_CANCELLED');
        expect(lateCallback).toMatchObject({
          errorCode: 'VIDEO_EXPORT_CANCELLED',
          status: 'CANCELLED',
        });
        await expect(
          uow.run(({ composition }) =>
            requireValue(composition).composition.createExportJob({
              episodeId: 'episode_1',
              id: 'export_2',
              inputHash: HASH,
              projectId: 'project_1',
              requestId: 'request_1',
              timelineVersionId: 'timeline_v1',
              totalDurationMs: 5_000,
            }),
          ),
        ).rejects.toBeDefined();
        await expect(
          uow.run(async ({ composition }) => {
            await requireValue(composition).composition.insertAudioAsset({
              byteSize: 10,
              fileSha256: HASH_B,
              id: 'audio_rollback',
              mimeType: 'audio/wav',
              originalFileName: 'rollback.wav',
              projectId: 'project_1',
              storageRelPath: `projects/project_1/audio/bb/${HASH_B}.wav`,
            });
            throw new Error('ROLLBACK_TEST');
          }),
        ).rejects.toThrow('ROLLBACK_TEST');
        expect(
          database.prepare('SELECT count(*) AS count FROM video_export_jobs').get()?.count,
        ).toBe(1);
        expect(
          database
            .prepare("SELECT count(*) AS count FROM video_audio_assets WHERE id='audio_rollback'")
            .get()?.count,
        ).toBe(0);
      } finally {
        database.close();
      }
    });
  });
});
