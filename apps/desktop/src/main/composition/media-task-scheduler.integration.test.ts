import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMediaTaskScheduler } from '@jingxu/application';
import { MockImageModelAdapter } from '@jingxu/model-adapters';
import {
  applyMigrations,
  createContentAddressedStore,
  loadMigrationSet,
  SqliteConnectionManager,
  SqliteMediaUnitOfWork,
} from '@jingxu/persistence';

const MIGRATIONS = path.resolve(
  import.meta.dirname,
  '../../../../../packages/persistence/resources/migrations',
);
const NOW = '2026-08-16T00:00:00.000Z';
const MODEL_ID = 'doubao-seedream-5-0-lite-260128';
/** 0009 CHECK 要求 generation_input_hash 为 64 位；测试种子按前缀展开成定长哈希形态。 */
const hash64 = (seed: string): string => `${seed}_${'.'.repeat(64)}`.slice(0, 64);

const ASYNC_STEPS = Array.from({ length: 4 }, () => ({ kind: 'ASYNC' as const, pendingPolls: 1 }));
const SYNC_STEPS = Array.from({ length: 4 }, () => ({ kind: 'SYNC' as const }));

type TestDatabase = ReturnType<SqliteConnectionManager['open']>;

interface Session {
  readonly database: TestDatabase;
  readonly unitOfWork: SqliteMediaUnitOfWork;
}

interface Harness {
  readonly close: () => void;
  readonly managedRoot: string;
  readonly openSession: () => Session;
  readonly root: string;
}

/** 真库 + 真内容寻址存储 + Mock Provider 的组合根装配（tasks.md 4.2 集成验证）。 */
const createHarness = async (prefix: string): Promise<Harness> => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(path.join(root, 'data'), { recursive: true });
  const migrations = await loadMigrationSet(MIGRATIONS);
  const managers: SqliteConnectionManager[] = [];
  const openSession = (): Session => {
    const manager = new SqliteConnectionManager(path.join(root, 'data', 'jingxu.sqlite'));
    const database = manager.open();
    managers.push(manager);
    applyMigrations(database, migrations, () => NOW);
    return { database, unitOfWork: new SqliteMediaUnitOfWork(database, () => NOW) };
  };
  return {
    close: () => {
      for (const manager of managers.splice(0)) manager.close();
    },
    managedRoot: path.join(root, 'managed'),
    openSession,
    root,
  };
};

/** media 仓储 FK 依赖的项目/画幅/分镜基础行（同持久层集成测试种子）。 */
const seedBaseRows = (
  database: TestDatabase,
  shots: readonly (readonly [shotId: string, versionId: string])[],
): void => {
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
  for (const [shotId, versionId] of shots) {
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
  }
};

const buildScheduler = (
  session: Session,
  provider: MockImageModelAdapter,
  harness: Harness,
  counts: { downloads: number; submits: number },
  downloadGate?: Promise<void>,
): ReturnType<typeof createMediaTaskScheduler> => {
  const store = createContentAddressedStore(harness.managedRoot);
  return createMediaTaskScheduler({
    fileStore: {
      writeImage: ({ bytes, mimeType, projectId }) =>
        store.write({ bytes, mimeType, namespace: 'images', projectId }),
    },
    imageModel: {
      validateCredential: () => provider.validateCredential(),
      submit: (request, signal) => {
        counts.submits += 1;
        return provider.submit(request, signal);
      },
      poll: (providerTaskId, signal) => provider.poll(providerTaskId, signal),
      download: async (resultRef, signal) => {
        counts.downloads += 1;
        if (downloadGate !== undefined) await downloadGate;
        return provider.download(resultRef, signal);
      },
      normalizeError: (error) => provider.normalizeError(error),
      evidenceOf: (error) => provider.evidenceOf(error),
    },
    mediaUnitOfWork: session.unitOfWork,
    newId: (() => {
      let counter = 0;
      return () => `inv_composition_${String((counter += 1))}`;
    })(),
    nowMs: () => 0,
    pollDeadlineMs: 60_000,
    pollIntervalMs: 1,
    requestBuilder: {
      build: () =>
        Promise.resolve({
          modelId: MODEL_ID,
          prompt: '雨巷',
          referenceImages: [],
          size: { height: 8, width: 8 },
        }),
    },
    segmentTimeoutMs: 5_000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
};

describe('MediaTaskScheduler 组合根集成（真 SQLite + 内容寻址存储 + Mock Provider）', () => {
  it('重启—证据齐全恢复轮询零重发—无证据标记待人工—候选字节真实落盘', async () => {
    const harness = await createHarness('jingxu-media-restart-');
    const provider = new MockImageModelAdapter({ steps: ASYNC_STEPS });
    const counts = { downloads: 0, submits: 0 };
    try {
      const sessionA = harness.openSession();
      seedBaseRows(sessionA.database, [
        ['shot_resume', 'shotv_resume'],
        ['shot_bare', 'shotv_bare'],
      ]);
      // 崩溃模拟：提交已发生（Provider 侧留有任务）、证据已落库、进程随即终止。
      const resumeTask = await sessionA.unitOfWork.run(({ media }) =>
        media.insertTask({
          candidateCount: 4,
          generationInputHash: hash64('gen_resume'),
          id: 'task_resume',
          idempotencyKey: 'req_resume',
          projectId: 'project_media',
          shotId: 'shot_resume',
          shotVersionId: 'shotv_resume',
        }),
      );
      const candidates = await sessionA.unitOfWork.run(({ media }) =>
        media.insertCandidates({
          candidateIds: ['c_resume_1', 'c_resume_2', 'c_resume_3', 'c_resume_4'],
          generationInputHash: hash64('gen_resume'),
          modelId: MODEL_ID,
          projectId: 'project_media',
          roundNo: resumeTask.roundNo,
          shotId: 'shot_resume',
          shotVersionId: 'shotv_resume',
        }),
      );
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (candidate === undefined) continue;
        const submission = await provider.submit(
          {
            invocationId: `crash_inv_${String(index + 1)}`,
            modelId: MODEL_ID,
            prompt: '雨巷',
            referenceImages: [],
            size: { height: 8, width: 8 },
          },
          new AbortController().signal,
        );
        if (submission.kind !== 'ASYNC') throw new Error('mock step expected ASYNC');
        await sessionA.unitOfWork.run(({ media }) =>
          media.assignCandidateProviderTask(candidate.id, submission.providerTaskId),
        );
      }
      await sessionA.unitOfWork.run(({ media }) =>
        media.markTaskPolling('task_resume', 'mock-image-task-1'),
      );
      // 同项目第二个在飞任务：SUBMITTED 无任何证据（同步 Provider 崩溃窗口同型）。
      await sessionA.unitOfWork.run(({ media }) =>
        media.insertTask({
          candidateCount: 4,
          generationInputHash: hash64('gen_bare'),
          id: 'task_bare',
          idempotencyKey: 'req_bare',
          projectId: 'project_media',
          shotId: 'shot_bare',
          shotVersionId: 'shotv_bare',
        }),
      );
      await sessionA.unitOfWork.run(({ media }) =>
        media.insertCandidates({
          candidateIds: ['c_bare_1', 'c_bare_2', 'c_bare_3', 'c_bare_4'],
          generationInputHash: hash64('gen_bare'),
          modelId: MODEL_ID,
          projectId: 'project_media',
          roundNo: 1,
          shotId: 'shot_bare',
          shotVersionId: 'shotv_bare',
        }),
      );
      harness.close(); // —— 应用关闭（连接与调度器生命周期终结）——

      // —— 重启：同一数据库文件新会话新调度器；Provider 为外部状态共享实例 ——
      const sessionB = harness.openSession();
      const scheduler = buildScheduler(sessionB, provider, harness, counts);
      const outcomes = await scheduler.recover('project_media');
      expect(outcomes).toEqual(
        expect.arrayContaining([
          { action: 'RESUMED_POLLING', taskId: 'task_resume' },
          { action: 'MARKED_FAILED_PENDING_MANUAL', taskId: 'task_bare' },
        ]),
      );

      await scheduler.run('project_media');
      expect(counts.submits).toBe(0); // spec 不变式：不自动重发

      const task = await sessionB.unitOfWork.run(({ media }) =>
        media.findTaskById('project_media', 'task_resume'),
      );
      expect(task).toMatchObject({ phase: 'COMPLETED' });
      const bare = await sessionB.unitOfWork.run(({ media }) =>
        media.findTaskById('project_media', 'task_bare'),
      );
      expect(bare).toMatchObject({ errorCode: 'MEDIA_TASK_INTERRUPTED', phase: 'FAILED' });

      const finalCandidates = await sessionB.unitOfWork.run(({ media }) =>
        media.listCandidates('shot_resume'),
      );
      expect(finalCandidates.map((candidate) => candidate.status)).toEqual([
        'SUCCEEDED',
        'SUCCEEDED',
        'SUCCEEDED',
        'SUCCEEDED',
      ]);
      expect(finalCandidates.map((candidate) => candidate.invocationEvidenceRef)).toEqual([
        'mock-image-task-1',
        'mock-image-task-2',
        'mock-image-task-3',
        'mock-image-task-4',
      ]);
      const store = createContentAddressedStore(harness.managedRoot);
      for (const candidate of finalCandidates) {
        if (candidate.storageRelPath === null) throw new Error('storageRelPath missing');
        const bytes = await store.read(candidate.storageRelPath);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        expect(sha256).toBe(candidate.fileSha256); // 候选登记与磁盘字节内容寻址一致
        expect(candidate.byteSize).toBe(bytes.byteLength);
      }
    } finally {
      harness.close();
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it('取消—迟到下载经事务内相位复核不落库—候选保持 PENDING', async () => {
    const harness = await createHarness('jingxu-media-cancel-');
    const provider = new MockImageModelAdapter({ steps: SYNC_STEPS });
    const counts = { downloads: 0, submits: 0 };
    let releaseDownload: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    try {
      const session = harness.openSession();
      seedBaseRows(session.database, [['shot_cancel', 'shotv_cancel']]);
      const task = await session.unitOfWork.run(({ media }) =>
        media.insertTask({
          candidateCount: 4,
          generationInputHash: hash64('gen_cancel'),
          id: 'task_cancel',
          idempotencyKey: 'req_cancel',
          projectId: 'project_media',
          shotId: 'shot_cancel',
          shotVersionId: 'shotv_cancel',
        }),
      );
      await session.unitOfWork.run(({ media }) =>
        media.insertCandidates({
          candidateIds: ['c_cancel_1', 'c_cancel_2', 'c_cancel_3', 'c_cancel_4'],
          generationInputHash: hash64('gen_cancel'),
          modelId: MODEL_ID,
          projectId: 'project_media',
          roundNo: task.roundNo,
          shotId: 'shot_cancel',
          shotVersionId: 'shotv_cancel',
        }),
      );
      const scheduler = buildScheduler(session, provider, harness, counts, gate);
      const driven = scheduler.run('project_media');
      await new Promise((resolve) => setTimeout(resolve, 50)); // 等 submit→download 挂起
      expect(counts.downloads).toBe(1);
      const cancelled = await scheduler.cancel('project_media', 'task_cancel');
      expect(cancelled).toMatchObject({ phase: 'CANCELLED' });
      releaseDownload();
      await driven;

      expect(counts.submits).toBe(1); // 后续候选不再提交
      const candidates = await session.unitOfWork.run(({ media }) =>
        media.listCandidates('shot_cancel'),
      );
      expect(candidates.map((candidate) => candidate.status)).toEqual([
        'PENDING',
        'PENDING',
        'PENDING',
        'PENDING',
      ]); // 迟到下载未登记（孤儿文件由空间治理独立处理）
      const fresh = await session.unitOfWork.run(({ media }) =>
        media.findTaskById('project_media', 'task_cancel'),
      );
      expect(fresh).toMatchObject({ phase: 'CANCELLED' });
    } finally {
      harness.close();
      await rm(harness.root, { force: true, recursive: true });
    }
  });
});
