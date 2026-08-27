import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { VoiceJobRecord } from '@jingxu/application';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import type { SqliteDatabase } from '../runtime/sqlite-database';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { SqliteVoiceGenerationRepository } from './sqlite-voice-generation-repository';
import { SqliteVoiceMappingRepository } from './sqlite-voice-mapping-repository';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-27T00:00:00.000Z';
const HASH = 'a'.repeat(64);
const PROJECT = 'project_1';

/** 候选外键链最小图（projects → episodes → shots → shot_contract_versions）。 */
const seedVoiceRepositoryGraph = (database: SqliteDatabase): void => {
  database
    .prepare(
      `INSERT INTO projects
       (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      PROJECT,
      'V2',
      'AI_ORIGINAL',
      'NARRATION_FIRST',
      'LOCAL_DEMO',
      `projects/${PROJECT}`,
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO format_profiles
       (id, project_id, version_no, aspect_ratio, width, height, fps, language, subtitle_safe_area_json, is_current, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('format_1', PROJECT, 1, '9:16', 1080, 1920, 24, 'zh-CN', '{}', 1, NOW);
  database
    .prepare(
      `INSERT INTO episodes (id, project_id, title, target_duration_sec, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('episode_1', PROJECT, '第一集', 90, NOW, NOW);
  for (const shot of ['shot_1', 'shot_2']) {
    database
      .prepare(
        `INSERT INTO shots (id, episode_id, lifecycle_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(shot, 'episode_1', 'ACTIVE', NOW, NOW);
    database
      .prepare(
        `INSERT INTO shot_contract_versions
         (id, shot_id, version_no, lineage_resolution_status, sequence, version_status, format_profile_id,
          target_duration_sec, dialogue_render_mode, document_json, document_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `shotv_${shot}`,
        shot,
        1,
        'ROOT',
        1,
        'READY',
        'format_1',
        5,
        'NARRATION_FIRST',
        '{}',
        HASH,
        NOW,
      );
  }
};

const jobRow = (input: {
  id: string;
  requestId: string;
  skipped?: { reason: 'NOT_VOICE_TARGET'; shotId: string }[];
  status?: VoiceJobRecord['status'];
  shotIds?: string[];
}): VoiceJobRecord => ({
  createdAt: NOW,
  episodeId: 'episode_1',
  evidence: [],
  id: input.id,
  projectId: PROJECT,
  requestId: input.requestId,
  skippedShots: input.skipped ?? [],
  status: input.status ?? 'QUEUED',
  targetShotIds: input.shotIds ?? ['shot_1', 'shot_2'],
  updatedAt: NOW,
});

const pendingCandidate = (input: {
  id: string;
  jobId: string;
  roundNo?: number;
  shotId: string;
}) => ({
  byteSize: null,
  createdAt: NOW,
  durationMs: null,
  errorCode: null,
  fileSha256: null,
  generationInputHash: HASH,
  id: input.id,
  indexInRound: 0,
  jobId: input.jobId,
  mimeType: null,
  modelId: 'qwen3-tts-instruct-flash',
  projectId: PROJECT,
  roundNo: input.roundNo ?? 1,
  selectedAt: null,
  shotId: input.shotId,
  shotVersionId: `shotv_${input.shotId}`,
  speakerId: 'narrator',
  spokenTextSha256: HASH,
  status: 'PENDING' as const,
  storageRelPath: null,
  updatedAt: NOW,
  voiceId: 'Neil',
});

const REGISTRATION = {
  byteSize: 1_024,
  durationMs: 1_500,
  fileSha256: 'b'.repeat(64),
  mimeType: 'audio/wav' as const,
  storageRelPath: `projects/${PROJECT}/audio/bb/${'b'.repeat(64)}.wav`,
};

const expectGuard = async (operation: () => Promise<unknown>, code: string): Promise<void> => {
  await expect(operation).rejects.toMatchObject({ code });
};

describe('SqliteVoiceGenerationRepository（tasks 4.2）', () => {
  it('job 生命周期—JSON 字段往返、终态守卫与 requestId 幂等冲突', async () => {
    await withSqliteTestContext(async (context) => {
      const database = new SqliteTestDatabase(path.join(context.root, 'voice-repo-a.db'));
      try {
        database.pragma('foreign_keys = ON');
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        seedVoiceRepositoryGraph(database);
        const repository = new SqliteVoiceGenerationRepository(database);

        const job = jobRow({
          id: 'job_1',
          requestId: 'request_1',
          skipped: [{ reason: 'NOT_VOICE_TARGET', shotId: 'shot_9' }],
        });
        await repository.insertJob(job);
        const roundTrip = await repository.findJobByRequest(PROJECT, 'request_1');
        expect(roundTrip).toMatchObject({
          episodeId: 'episode_1',
          id: 'job_1',
          skippedShots: [{ reason: 'NOT_VOICE_TARGET', shotId: 'shot_9' }],
          status: 'QUEUED',
          targetShotIds: ['shot_1', 'shot_2'],
        });
        expect(await repository.findActiveJobByProject(PROJECT)).not.toBeNull();

        await repository.markJobRunning('job_1', NOW);
        // 同目标转移重放幂等（requireTaskPhase 口径）；反向转移才抛守卫码。
        await repository.markJobRunning('job_1', NOW);
        await repository.finalizeJob('job_1', 'COMPLETED', NOW);
        await repository.finalizeJob('job_1', 'COMPLETED', NOW);
        await expectGuard(() => repository.markJobRunning('job_1', NOW), 'VOICE_JOB_NOT_QUEUED');
        expect(await repository.findActiveJobByProject(PROJECT)).toBeNull();

        await expectGuard(
          () => repository.insertJob(jobRow({ id: 'job_2', requestId: 'request_1' })),
          'VOICE_JOB_IDEMPOTENCY_CONFLICT',
        );
      } finally {
        database.close();
      }
    });
  });

  it('取消先落库—状态与 CANCELLED 证据原子写、终态 job 取消为 no-op', async () => {
    await withSqliteTestContext(async (context) => {
      const database = new SqliteTestDatabase(path.join(context.root, 'voice-repo-b.db'));
      try {
        database.pragma('foreign_keys = ON');
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        seedVoiceRepositoryGraph(database);
        const repository = new SqliteVoiceGenerationRepository(database);

        await repository.insertJob(jobRow({ id: 'job_1', requestId: 'request_1' }));
        await repository.appendJobEvidence('job_1', {
          at: NOW,
          candidateId: 'vcan_0001',
          outcome: 'STARTED',
          shotId: 'shot_1',
        });
        await repository.cancelJob('job_1', NOW);
        const cancelled = await repository.findJobById(PROJECT, 'job_1');
        expect(cancelled?.status).toBe('CANCELLED');
        expect(cancelled?.evidence.map((entry) => entry.outcome)).toEqual(['STARTED', 'CANCELLED']);
        expect(cancelled?.evidence[1]?.shotId).toBe('*');

        // 终态 job 再取消：不改状态、不追加证据。
        await repository.cancelJob('job_1', NOW);
        const after = await repository.findJobById(PROJECT, 'job_1');
        expect(after?.evidence).toHaveLength(2);
      } finally {
        database.close();
      }
    });
  });

  it('候选生命周期—四元组终态、失败/中断码、STALE 只迁 SUCCEEDED、选中指针互斥、删除仅登记', async () => {
    await withSqliteTestContext(async (context) => {
      const database = new SqliteTestDatabase(path.join(context.root, 'voice-repo-c.db'));
      try {
        database.pragma('foreign_keys = ON');
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        seedVoiceRepositoryGraph(database);
        const repository = new SqliteVoiceGenerationRepository(database);
        await repository.insertJob(jobRow({ id: 'job_1', requestId: 'request_1' }));

        expect(await repository.nextRoundNo('shot_1')).toBe(1);
        await repository.insertCandidate(
          pendingCandidate({ id: 'vcan_1', jobId: 'job_1', shotId: 'shot_1' }),
        );
        await expectGuard(
          () =>
            repository.insertCandidate(
              pendingCandidate({ id: 'vcan_dup', jobId: 'job_1', roundNo: 1, shotId: 'shot_1' }),
            ),
          'VOICE_CANDIDATE_DUPLICATE',
        );
        await repository.finalizeCandidateSucceeded('vcan_1', REGISTRATION, NOW);
        // 同目标终态重放幂等（沿 requireTaskPhase 口径：到达目标即成功）；
        // 反向转移（SUCCEEDED→FAILED）才抛守卫码。
        await repository.finalizeCandidateSucceeded('vcan_1', REGISTRATION, NOW);
        const succeeded = await repository.findCandidate(PROJECT, 'vcan_1');
        expect(succeeded).toMatchObject({
          byteSize: 1_024,
          durationMs: 1_500,
          fileSha256: 'b'.repeat(64),
          mimeType: 'audio/wav',
          status: 'SUCCEEDED',
          storageRelPath: REGISTRATION.storageRelPath,
        });

        // 同镜头第二轮成功候选：选中指针互斥（partial unique 语义）。
        await repository.insertCandidate(
          pendingCandidate({ id: 'vcan_2', jobId: 'job_1', roundNo: 2, shotId: 'shot_1' }),
        );
        await repository.finalizeCandidateSucceeded('vcan_2', REGISTRATION, NOW);
        await repository.selectCandidate('vcan_2', NOW);
        await repository.selectCandidate('vcan_1', NOW);
        const shotCandidates = await repository.listCandidatesByShot('shot_1');
        expect(shotCandidates.find((row) => row.id === 'vcan_1')?.selectedAt).toBe(NOW);
        expect(shotCandidates.find((row) => row.id === 'vcan_2')?.selectedAt).toBeNull();
        expect(await repository.nextRoundNo('shot_1')).toBe(3);

        // 失败/中断候选：错误码落位、不可选中。
        await repository.insertCandidate(
          pendingCandidate({ id: 'vcan_3', jobId: 'job_1', shotId: 'shot_2' }),
        );
        await repository.finalizeCandidateFailed('vcan_3', 'MODEL_UNKNOWN', NOW);
        await expectGuard(
          () => repository.selectCandidate('vcan_3', NOW),
          'VOICE_CANDIDATE_NOT_SELECTABLE',
        );
        await repository.insertCandidate(
          pendingCandidate({ id: 'vcan_4', jobId: 'job_1', roundNo: 2, shotId: 'shot_2' }),
        );
        await repository.interruptCandidate('vcan_4', 'VOICE_INTERRUPTED', NOW);

        // STALE 迁移：只动 SUCCEEDED 行（FAILED/STALE_INPUT 不重复迁移）。
        await repository.markCandidatesStale(['vcan_1', 'vcan_3'], NOW);
        const afterStale = await repository.listCandidatesByShot('shot_1');
        const staleRow = afterStale.find((row) => row.id === 'vcan_1');
        expect(staleRow?.status).toBe('STALE_INPUT');
        // 0020 CHECK：非 SUCCEEDED 行 duration_ms 为 NULL；文件四元组保留。
        expect(staleRow?.durationMs).toBeNull();
        expect(staleRow?.fileSha256).toBe('b'.repeat(64));
        const shotTwo = await repository.listCandidatesByShot('shot_2');
        expect(shotTwo.find((row) => row.id === 'vcan_3')?.status).toBe('FAILED');
        // SUCCEEDED 哈希底座：vcan_2（shot_1）在列，shot_2 全失败不在列。
        expect(await repository.listSucceededShotHashes(PROJECT)).toEqual([
          { generationInputHash: HASH, shotId: 'shot_1' },
        ]);

        // 删除仅登记行：行消失、二次删除稳定拒绝。
        await repository.deleteCandidate('vcan_1');
        expect(await repository.findCandidate(PROJECT, 'vcan_1')).toBeNull();
        await expectGuard(() => repository.deleteCandidate('vcan_1'), 'VOICE_CANDIDATE_NOT_FOUND');
      } finally {
        database.close();
      }
    });
  });
});

describe('SqliteVoiceMappingRepository（tasks 4.2）', () => {
  it('集合整体替换—先删后插原子、speaker 排序返回', async () => {
    await withSqliteTestContext(async (context) => {
      const database = new SqliteTestDatabase(path.join(context.root, 'voice-mapping.db'));
      try {
        database.pragma('foreign_keys = ON');
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        database
          .prepare(
            `INSERT INTO projects
             (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            PROJECT,
            'V2',
            'AI_ORIGINAL',
            'NARRATION_FIRST',
            'LOCAL_DEMO',
            `projects/${PROJECT}`,
            NOW,
            NOW,
          );
        const repository = new SqliteVoiceMappingRepository(database);

        const saved = await repository.replaceAll(PROJECT, [
          { projectId: PROJECT, speakerId: 'narrator', updatedAt: NOW, voiceId: 'Neil' },
          { projectId: PROJECT, speakerId: 'char_a', updatedAt: NOW, voiceId: 'Elias' },
        ]);
        expect(saved.map((row) => row.speakerId)).toEqual(['char_a', 'narrator']);
        expect(await repository.listByProject(PROJECT)).toHaveLength(2);

        // 整体替换：char_a 收敛删除，char_b 落位。
        await repository.replaceAll(PROJECT, [
          { projectId: PROJECT, speakerId: 'narrator', updatedAt: NOW, voiceId: 'Neil' },
          { projectId: PROJECT, speakerId: 'char_b', updatedAt: NOW, voiceId: 'Cherry' },
        ]);
        const after = await repository.listByProject(PROJECT);
        expect(after.map((row) => row.speakerId)).toEqual(['char_b', 'narrator']);
      } finally {
        database.close();
      }
    });
  });
});
