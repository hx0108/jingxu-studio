import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteMediaInvocationRepository } from './sqlite-media-invocation-repository';
import { SqliteMediaRepository } from './sqlite-media-repository';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-19T00:00:00.000Z';
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
    database
      .prepare(
        `INSERT INTO shots (id, episode_id, lifecycle_status, created_at, updated_at)
         VALUES ('shot_media', 'episode_media', 'ACTIVE', ?, ?)`,
      )
      .run(NOW, NOW);
    database
      .prepare(
        `INSERT INTO shot_contract_versions
         (id, shot_id, version_no, lineage_resolution_status, sequence, version_status, format_profile_id,
          target_duration_sec, dialogue_render_mode, document_json, document_sha256, created_at)
         VALUES ('shotv_media', 'shot_media', 1, 'ROOT', 1, 'DRAFT', 'format_media', 8,
                 'NARRATION_FIRST', '{}', 'sha_shotv_media', ?)`,
      )
      .run(NOW);
    const media = new SqliteMediaRepository(database, () => NOW);
    await media.insertTask({
      candidateCount: 4,
      generationInputHash: hash64('h1'),
      id: 'task_media',
      idempotencyKey: 'image-generate_task_media',
      projectId: 'project_media',
      shotId: 'shot_media',
      shotVersionId: 'shotv_media',
    });
    await media.insertCandidates({
      candidateIds: ['cand_a', 'cand_b', 'cand_c', 'cand_d'],
      generationInputHash: hash64('h1'),
      modelId: MODEL_ID,
      projectId: 'project_media',
      roundNo: 1,
      shotId: 'shot_media',
      shotVersionId: 'shotv_media',
    });
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

describe('SqliteMediaInvocationRepository（media-invocation-evidence D1/D4）', () => {
  it('两段式正例—STARTED 插入→SUCCEEDED 收尾含响应/usage/截断标记→listByTask 有序', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'media_invocation_roundtrip.sqlite');
      try {
        const repository = new SqliteMediaInvocationRepository(database, () => NOW);
        const snapshotJson = JSON.stringify({
          modelId: MODEL_ID,
          prompt: '夜市霓虹',
          referenceImageSha256s: [],
          size: { height: 2560, width: 1440 },
        });
        await repository.insert({
          candidateId: 'cand_a',
          id: 'inv_submit_a',
          mediaTaskId: 'task_media',
          modelId: MODEL_ID,
          requestSha256: 'req_sha_inv_a',
          requestSnapshotJson: snapshotJson,
          segmentKind: 'SUBMIT',
        });
        await expect(repository.findById('inv_submit_a')).resolves.toMatchObject({
          rawResponseBlob: null,
          rawResponseTruncated: false,
          segmentKind: 'SUBMIT',
          status: 'STARTED',
        });
        const bodyText = '{"id":"resp-1","usage":{"generated_images":1}}';
        await expect(
          repository.finishTerminal('inv_submit_a', {
            finishedAt: NOW,
            providerRequestId: 'resp-1',
            providerReportedGeneratedImages: 1,
            providerReportedOutputTokens: 4096,
            rawResponseBlob: new TextEncoder().encode(bodyText),
            rawResponseSha256: 'resp_sha_1',
            rawResponseTruncated: true,
            responseHttpStatus: 200,
            status: 'SUCCEEDED',
          }),
        ).resolves.toBe(true);
        await expect(repository.findById('inv_submit_a')).resolves.toMatchObject({
          errorCode: null,
          finishedAt: NOW,
          providerRequestId: 'resp-1',
          providerReportedGeneratedImages: 1,
          providerReportedOutputTokens: 4096,
          rawResponseSha256: 'resp_sha_1',
          rawResponseTruncated: true,
          responseHttpStatus: 200,
          status: 'SUCCEEDED',
        });
        // DOWNLOAD 轻量行：blob 恒 NULL，只记 sha256。
        await repository.insert({
          candidateId: 'cand_a',
          id: 'inv_download_a',
          mediaTaskId: 'task_media',
          modelId: MODEL_ID,
          requestSha256: 'req_sha_dl_a',
          requestSnapshotJson: JSON.stringify({ resultUrl: 'https://example.test/img.png' }),
          segmentKind: 'DOWNLOAD',
        });
        await expect(
          repository.finishTerminal('inv_download_a', {
            finishedAt: NOW,
            rawResponseSha256: 'image_sha_a',
            responseHttpStatus: 200,
            status: 'SUCCEEDED',
          }),
        ).resolves.toBe(true);
        // 时钟冻结下 created_at 相同，排序退化为 id 序——断言不依赖插入顺序。
        await expect(repository.listByTaskId('task_media')).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 'inv_submit_a', segmentKind: 'SUBMIT' }),
            expect.objectContaining({
              id: 'inv_download_a',
              rawResponseBlob: null,
              segmentKind: 'DOWNLOAD',
            }),
          ]),
        );
        expect((await repository.listByTaskId('task_media')).length).toBe(2);
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('失败收尾—归一 error_code 与错误原文落 blob；非 STARTED 幂等拒绝返回 false', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'media_invocation_failure.sqlite');
      try {
        const repository = new SqliteMediaInvocationRepository(database, () => NOW);
        await repository.insert({
          candidateId: 'cand_b',
          id: 'inv_submit_b',
          mediaTaskId: 'task_media',
          modelId: MODEL_ID,
          requestSha256: 'req_sha_inv_b',
          requestSnapshotJson: '{}',
          segmentKind: 'SUBMIT',
        });
        await expect(
          repository.finishTerminal('inv_submit_b', {
            errorCode: 'MODEL_RATE_LIMITED',
            finishedAt: NOW,
            rawResponseBlob: new TextEncoder().encode('{"error":{"code":"SetLimitExceeded"}}'),
            responseHttpStatus: 429,
            status: 'FAILED',
          }),
        ).resolves.toBe(true);
        await expect(repository.findById('inv_submit_b')).resolves.toMatchObject({
          errorCode: 'MODEL_RATE_LIMITED',
          providerReportedGeneratedImages: null,
          responseHttpStatus: 429,
          status: 'FAILED',
        });
        // 已终态：再次收尾（迟到响应场景）与未知 id 均拒绝。
        await expect(
          repository.finishTerminal('inv_submit_b', {
            finishedAt: NOW,
            status: 'SUCCEEDED',
          }),
        ).resolves.toBe(false);
        await expect(
          repository.finishTerminal('inv_unknown', { finishedAt: NOW, status: 'FAILED' }),
        ).resolves.toBe(false);
      } finally {
        database.close();
      }
    });
  });

  it('守卫—重复 id 插入与外键缺失—稳定持久化标记拒绝', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await setup(root, 'media_invocation_guards.sqlite');
      try {
        const repository = new SqliteMediaInvocationRepository(database, () => NOW);
        await repository.insert({
          candidateId: 'cand_c',
          id: 'inv_dup',
          mediaTaskId: 'task_media',
          modelId: MODEL_ID,
          requestSha256: 'req_sha_dup',
          requestSnapshotJson: '{}',
          segmentKind: 'SUBMIT',
        });
        await expect(
          repository.insert({
            candidateId: 'cand_c',
            id: 'inv_dup',
            mediaTaskId: 'task_media',
            modelId: MODEL_ID,
            requestSha256: 'req_sha_dup',
            requestSnapshotJson: '{}',
            segmentKind: 'SUBMIT',
          }),
        ).rejects.toThrow('MEDIA_INVOCATION_PERSISTENCE_FAILED');
        // candidate_id 外键缺失（候选行不存在）。
        await expect(
          repository.insert({
            candidateId: 'cand_missing',
            id: 'inv_fk',
            mediaTaskId: 'task_media',
            modelId: MODEL_ID,
            requestSha256: 'req_sha_fk',
            requestSnapshotJson: '{}',
            segmentKind: 'SUBMIT',
          }),
        ).rejects.toThrow('MEDIA_INVOCATION_PERSISTENCE_FAILED');
      } finally {
        database.close();
      }
    });
  });
});
