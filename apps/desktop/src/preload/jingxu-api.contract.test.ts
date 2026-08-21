import {
  IMAGE_IPC_CHANNELS,
  PROJECT_IPC_CHANNELS,
  VIDEO_IPC_CHANNELS,
  type AppResultDto,
  type CreateProjectInputDto,
  type JingxuApi,
  type MediaBatchViewDto,
  type MediaTaskViewDto,
  type ProjectDetailDto,
  type StoryboardVideoStatesDto,
  type VideoCandidateViewDto,
} from '@jingxu/contracts';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { createJingxuApi, RUNTIME_IPC_CHANNELS } from './jingxu-api';

const createInput: CreateProjectInputDto = {
  requestId: 'request-create-0001',
  name: '雾都来信',
  genre: '悬疑',
  style: '电影感',
  creationMode: 'AI_ORIGINAL',
  dialogueRenderMode: 'NARRATION_FIRST',
  aspectRatio: '9:16',
  subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
};

const detail: ProjectDetailDto = {
  id: 'project_12345678',
  name: '雾都来信',
  genre: '悬疑',
  style: '电影感',
  creationMode: 'AI_ORIGINAL',
  dialogueRenderMode: 'NARRATION_FIRST',
  deploymentMode: 'LOCAL_DEMO',
  createdAt: '2026-08-10T01:00:00.000Z',
  updatedAt: '2026-08-10T01:00:00.000Z',
  deletedAt: null,
  currentFormatProfile: {
    id: 'format_12345678',
    projectId: 'project_12345678',
    versionNo: 1,
    parentId: null,
    aspectRatio: '9:16',
    width: 1080,
    height: 1920,
    fps: 30,
    language: 'zh-CN',
    subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
    isCurrent: true,
    createdAt: '2026-08-10T01:00:00.000Z',
  },
  formatProfileHistory: [],
};

const okDetail: AppResultDto<ProjectDetailDto> = { ok: true, data: detail };

describe('window.jingxu 白名单 Contract', () => {
  it('SQLite runtime Change—创建公开 API—只得到冻结的 runtime 三方法白名单', async () => {
    const invoke = vi.fn(() =>
      Promise.resolve({
        allowedActions: [],
        backups: [],
        completedPhases: [
          'DATABASE_OPEN',
          'CONNECTION_BASELINE',
          'MIGRATION',
          'DATABASE_AUDIT',
          'RECOVERY_GATE',
          'SCHEMA_REGISTRY',
        ],
        currentPhase: null,
        errorCode: null,
        retryable: false,
        revision: 2,
        state: 'READY',
        summary: null,
        writeEnabled: true,
      }),
    );
    const api = createJingxuApi(invoke);

    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.runtime)).toBe(true);
    expect(Object.isFrozen(api.project)).toBe(true);
    expect(Object.keys(api).sort()).toEqual([
      'events',
      'image',
      'job',
      'project',
      'provider',
      'runtime',
      'script',
      'storyboard',
      'video',
    ]);
    expect(Object.isFrozen(api.storyboard)).toBe(true);
    expect(Object.keys(api.script).sort()).toEqual([
      'confirmVersion',
      'getWorkspace',
      'initializeOriginal',
      'restoreVersion',
      'saveDraft',
    ]);
    expect(Object.keys(api.runtime).sort()).toEqual([
      'getStartupStatus',
      'restoreBackup',
      'retryStartup',
    ]);
    expectTypeOf(api).toEqualTypeOf<JingxuApi>();

    const retry = { expectedRevision: 1, requestId: 'request-retry-0001' };
    const restore = {
      backupId: 'backup_12345678',
      expectedRevision: 1,
      requestId: 'request-restore-0001',
    };
    await api.runtime.getStartupStatus();
    await api.runtime.retryStartup(retry);
    await api.runtime.restoreBackup(restore);
    expect(invoke.mock.calls).toEqual([
      [RUNTIME_IPC_CHANNELS.getStartupStatus],
      [RUNTIME_IPC_CHANNELS.retryStartup, retry],
      [RUNTIME_IPC_CHANNELS.restoreBackup, restore],
    ]);
  });

  it('Main 返回 Schema 只读故障—Preload 输出校验—保留稳定阶段且不暴露资源细节', async () => {
    const schemaFault = {
      allowedActions: ['RETRY'],
      backups: [],
      completedPhases: [
        'DATABASE_OPEN',
        'CONNECTION_BASELINE',
        'MIGRATION',
        'DATABASE_AUDIT',
        'RECOVERY_GATE',
      ],
      currentPhase: 'SCHEMA_REGISTRY',
      errorCode: 'SCHEMA_HASH_MISMATCH',
      retryable: true,
      revision: 3,
      state: 'READ_ONLY_FAULT',
      summary: 'Schema 资源完整性检查未通过，请修复资源后重试。',
      writeEnabled: false,
    } as const;
    const api = createJingxuApi(vi.fn(() => Promise.resolve(schemaFault)));

    await expect(api.runtime.getStartupStatus()).resolves.toEqual(schemaFault);
    expect(JSON.stringify(schemaFault)).not.toContain('C:\\');
    expect(JSON.stringify(schemaFault)).not.toContain('schema_registry_manifest');
  });

  it.each(['send', 'on', 'once', 'invoke'])(
    '检查 %s—Preload、runtime 与 project 均不提供通用频道入口',
    (methodName) => {
      const api = createJingxuApi(vi.fn());
      expect(Reflect.has(api, methodName)).toBe(false);
      expect(Reflect.has(api.runtime, methodName)).toBe(false);
      expect(Reflect.has(api.project, methodName)).toBe(false);
      expect(Reflect.has(api.job, methodName)).toBe(false);
      expect(Reflect.has(api.provider, methodName)).toBe(false);
      expect(Reflect.has(api.events, methodName)).toBe(false);
      expect(Reflect.has(api.image, methodName)).toBe(false);
      expect(Reflect.has(api.video, methodName)).toBe(false);
    },
  );

  it('Image Change—image 恰有冻结的九方法白名单—零路径/SQL/存储入口', () => {
    const api = createJingxuApi(vi.fn());

    expect(Object.isFrozen(api.image)).toBe(true);
    expect(Object.keys(api.image).sort()).toEqual([
      'cancelBatch',
      'generateCandidates',
      'generateCandidatesForShots',
      'getMediaTask',
      'listAssets',
      'listCandidates',
      'listStoryboardImageStates',
      'selectCandidate',
      'uploadAssetReference',
    ]);
    for (const forbidden of ['path', 'sql', 'database', 'repository', 'node', 'persistence']) {
      expect(Reflect.has(api.image, forbidden)).toBe(false);
    }
  });

  it('调用六个 image 方法—输入合法—只 invoke 固定 channel 且校验输出（字节引用原样透传）', async () => {
    const now = '2026-08-16T00:00:00.000Z';
    const hash = 'a'.repeat(64);
    const task = {
      candidateCount: 4,
      createdAt: now,
      errorCode: null,
      generationInputHash: hash,
      id: 'task_12345678',
      phase: 'COMPLETED' as const,
      shotId: 'shot_12345678',
      shotVersionId: 'scv_12345678',
      updatedAt: now,
    };
    const candidate = {
      byteSize: 1024,
      createdAt: now,
      errorCode: null,
      generationInputHash: hash,
      height: 1440,
      id: 'cand_12345678',
      indexInRound: 0,
      mediaUrl: 'jingxu://media/candidate/cand_12345678',
      mimeType: 'image/png',
      roundNo: 1,
      selectedAt: null,
      shotId: 'shot_12345678',
      shotVersionId: 'scv_12345678',
      status: 'SUCCEEDED' as const,
      width: 2560,
    };
    const assetVersion = {
      assetId: 'asset_12345678',
      byteSize: 3,
      createdAt: now,
      description: null,
      height: null,
      id: 'assetv_12345678',
      mediaUrl: 'jingxu://media/asset-version/assetv_12345678',
      mimeType: 'image/png' as const,
      provenance: 'UPLOADED' as const,
      versionNo: 1,
      width: null,
    };
    const invoke = vi.fn((channel: string) => {
      switch (channel) {
        case IMAGE_IPC_CHANNELS.generateCandidates:
        case IMAGE_IPC_CHANNELS.getTask:
          return Promise.resolve({ data: task, ok: true });
        case IMAGE_IPC_CHANNELS.listCandidates:
        case IMAGE_IPC_CHANNELS.selectCandidate:
          return Promise.resolve({ data: [candidate], ok: true });
        case IMAGE_IPC_CHANNELS.listAssets:
          return Promise.resolve({
            data: [
              {
                assetType: 'SCENE',
                bibleRefId: 'scene_12345678',
                createdAt: now,
                currentVersion: assetVersion,
                displayName: '雨巷',
                id: 'asset_12345678',
                projectId: 'project_12345678',
                updatedAt: now,
                versions: [assetVersion],
              },
            ],
            ok: true,
          });
        default:
          return Promise.resolve({
            data: {
              affectedShots: [{ candidateCount: 4, shotId: 'shot_12345678' }],
              version: assetVersion,
            },
            ok: true,
          });
      }
    });
    const api = createJingxuApi(invoke);
    const generateInput = {
      projectId: 'project_12345678',
      requestId: 'request_gen_00001',
      shotId: 'shot_12345678',
    };
    const listCandidatesInput = { projectId: 'project_12345678', shotId: 'shot_12345678' };
    const selectInput = {
      candidateId: 'cand_12345678',
      projectId: 'project_12345678',
      requestId: 'request_sel_00001',
    };
    const listAssetsInput = { projectId: 'project_12345678' };
    const uploadInput = {
      assetType: 'SCENE' as const,
      bibleRefId: 'scene_12345678',
      byteSize: 3,
      bytes: Uint8Array.from([1, 2, 3]),
      description: null,
      displayName: '雨巷',
      mimeType: 'image/png' as const,
      projectId: 'project_12345678',
      requestId: 'request_upload_001',
    };
    const taskInput = { projectId: 'project_12345678', taskId: 'task_12345678' };

    await expect(api.image.generateCandidates(generateInput)).resolves.toEqual({
      data: task,
      ok: true,
    });
    await expect(api.image.listCandidates(listCandidatesInput)).resolves.toEqual({
      data: [candidate],
      ok: true,
    });
    await expect(api.image.selectCandidate(selectInput)).resolves.toEqual({
      data: [candidate],
      ok: true,
    });
    await expect(api.image.listAssets(listAssetsInput)).resolves.toMatchObject({
      data: [{ bibleRefId: 'scene_12345678' }],
      ok: true,
    });
    await expect(api.image.uploadAssetReference(uploadInput)).resolves.toMatchObject({
      data: { affectedShots: [{ shotId: 'shot_12345678' }], version: { versionNo: 1 } },
      ok: true,
    });
    await expect(api.image.getMediaTask(taskInput)).resolves.toEqual({ data: task, ok: true });
    expect(invoke.mock.calls).toEqual([
      [IMAGE_IPC_CHANNELS.generateCandidates, generateInput],
      [IMAGE_IPC_CHANNELS.listCandidates, listCandidatesInput],
      [IMAGE_IPC_CHANNELS.selectCandidate, selectInput],
      [IMAGE_IPC_CHANNELS.listAssets, listAssetsInput],
      // 预校验不改写字节缓冲：≤20MB Uint8Array 原样引用透传（无拷贝/序列化）。
      [IMAGE_IPC_CHANNELS.uploadAssetReference, { ...uploadInput, bytes: uploadInput.bytes }],
      [IMAGE_IPC_CHANNELS.getTask, taskInput],
    ]);
    const uploadCall = (invoke.mock.calls as readonly (readonly unknown[])[]).find(
      ([channel]) => channel === IMAGE_IPC_CHANNELS.uploadAssetReference,
    );
    expect((uploadCall?.[1] as { bytes: Uint8Array }).bytes).toBe(uploadInput.bytes);

    // 输出校验：越权字段的媒体任务不得进入 Renderer。
    await expect(
      createJingxuApi(
        vi.fn(() => Promise.resolve({ data: { ...task, sql: 'SELECT 1' }, ok: true })),
      ).image.getMediaTask(taskInput),
    ).rejects.toThrow();
  });

  it('Video Change—video 恰有冻结的七方法白名单—零路径/SQL/存储入口', () => {
    const api = createJingxuApi(vi.fn());

    expect(Object.isFrozen(api.video)).toBe(true);
    expect(Object.keys(api.video).sort()).toEqual([
      'cancelVideoBatch',
      'generateVideoCandidates',
      'generateVideosForShots',
      'getVideoTask',
      'listStoryboardVideoStates',
      'listVideoCandidates',
      'selectVideoCandidate',
    ]);
    for (const forbidden of ['path', 'sql', 'database', 'repository', 'node', 'persistence']) {
      expect(Reflect.has(api.video, forbidden)).toBe(false);
    }
  });

  it('调用七个 video 方法—输入合法—只 invoke 固定 channel 且校验输出（首帧/模型指纹不透出）', async () => {
    const now = '2026-08-16T00:00:00.000Z';
    const hash = 'a'.repeat(64);
    const task: MediaTaskViewDto = {
      candidateCount: 2,
      createdAt: now,
      errorCode: null,
      generationInputHash: hash,
      id: 'task_12345678',
      phase: 'SUBMITTED',
      shotId: 'shot_12345678',
      shotVersionId: 'scv_12345678',
      updatedAt: now,
    };
    const candidate: VideoCandidateViewDto = {
      actualDurationSec: 8,
      byteSize: 2048,
      continuationSegmentCount: 0,
      createdAt: now,
      errorCode: null,
      firstFrameCandidateId: 'cand_12345678',
      generationInputHash: hash,
      height: 1920,
      id: 'vcand_12345678',
      indexInRound: 0,
      mediaUrl: 'jingxu://media/video-candidate/vcand_12345678',
      mimeType: 'video/mp4',
      requestedDurationSec: 8,
      roundNo: 1,
      selectedAt: null,
      shotId: 'shot_12345678',
      shotVersionId: 'scv_12345678',
      status: 'SUCCEEDED',
      trimRange: null,
      width: 1080,
    };
    const batch: MediaBatchViewDto = {
      batchId: 'batch_12345678',
      createdAt: now,
      errorCode: null,
      members: [{ errorCode: null, phase: null, shotId: 'shot_12345678', taskId: null }],
      skippedShotIds: [],
      status: 'RUNNING',
      updatedAt: now,
    };
    const states: StoryboardVideoStatesDto = {
      batches: [batch],
      shots: [
        {
          activeTaskPhase: null,
          currentGenSucceededCount: 1,
          latestTaskErrorCode: null,
          queuedInBatchId: 'batch_12345678',
          shotId: 'shot_12345678',
        },
      ],
    };
    const invoke = vi.fn((channel: string) => {
      switch (channel) {
        case VIDEO_IPC_CHANNELS.generateVideoCandidates:
        case VIDEO_IPC_CHANNELS.getVideoTask:
          return Promise.resolve({ data: task, ok: true });
        case VIDEO_IPC_CHANNELS.listVideoCandidates:
        case VIDEO_IPC_CHANNELS.selectVideoCandidate:
          return Promise.resolve({ data: [candidate], ok: true });
        case VIDEO_IPC_CHANNELS.generateVideosForShots:
        case VIDEO_IPC_CHANNELS.cancelVideoBatch:
          return Promise.resolve({ data: batch, ok: true });
        default:
          return Promise.resolve({ data: states, ok: true });
      }
    });
    const api = createJingxuApi(invoke);
    const generateInput = {
      projectId: 'project_12345678',
      requestId: 'request_vgen_00001',
      shotId: 'shot_12345678',
    };
    const listInput = { projectId: 'project_12345678', shotId: 'shot_12345678' };
    const selectInput = {
      candidateId: 'vcand_12345678',
      projectId: 'project_12345678',
      requestId: 'request_vsel_00001',
    };
    const taskInput = { projectId: 'project_12345678', taskId: 'task_12345678' };
    const batchInput = {
      projectId: 'project_12345678',
      requestId: 'request_vbatch_0001',
      shotIds: ['shot_12345678'],
    };
    const cancelInput = {
      batchId: 'batch_12345678',
      projectId: 'project_12345678',
      requestId: 'request_vcancel_001',
    };
    const statesInput = { projectId: 'project_12345678' };

    await expect(api.video.generateVideoCandidates(generateInput)).resolves.toEqual({
      data: task,
      ok: true,
    });
    await expect(api.video.listVideoCandidates(listInput)).resolves.toEqual({
      data: [candidate],
      ok: true,
    });
    await expect(api.video.selectVideoCandidate(selectInput)).resolves.toEqual({
      data: [candidate],
      ok: true,
    });
    await expect(api.video.getVideoTask(taskInput)).resolves.toEqual({ data: task, ok: true });
    await expect(api.video.generateVideosForShots(batchInput)).resolves.toEqual({
      data: batch,
      ok: true,
    });
    await expect(api.video.cancelVideoBatch(cancelInput)).resolves.toEqual({
      data: batch,
      ok: true,
    });
    await expect(api.video.listStoryboardVideoStates(statesInput)).resolves.toEqual({
      data: states,
      ok: true,
    });
    expect(invoke.mock.calls).toEqual([
      [VIDEO_IPC_CHANNELS.generateVideoCandidates, generateInput],
      [VIDEO_IPC_CHANNELS.listVideoCandidates, listInput],
      [VIDEO_IPC_CHANNELS.selectVideoCandidate, selectInput],
      [VIDEO_IPC_CHANNELS.getVideoTask, taskInput],
      [VIDEO_IPC_CHANNELS.generateVideosForShots, batchInput],
      [VIDEO_IPC_CHANNELS.cancelVideoBatch, cancelInput],
      [VIDEO_IPC_CHANNELS.listStoryboardVideoStates, statesInput],
    ]);

    // 输出校验：越权字段（文件指纹/路径）的视频候选不得进入 Renderer。
    await expect(
      createJingxuApi(
        vi.fn(() =>
          Promise.resolve({
            data: [{ ...candidate, firstFrameFileSha256: hash, sql: 'SELECT 1' }],
            ok: true,
          }),
        ),
      ).video.listVideoCandidates(listInput),
    ).rejects.toThrow();
  });

  it('Project Change—创建公开 API—project 恰有冻结的六方法白名单', () => {
    const api = createJingxuApi(vi.fn());

    expect(Object.isFrozen(api.project)).toBe(true);
    expect(Object.keys(api.project).sort()).toEqual([
      'create',
      'delete',
      'get',
      'list',
      'restore',
      'update',
    ]);
    for (const forbidden of ['path', 'sql', 'database', 'repository', 'node', 'persistence']) {
      expect(Reflect.has(api.project, forbidden)).toBe(false);
    }
  });

  it('调用六个 Project 方法—输入合法—只 invoke 对应固定 channel 并校验输出', async () => {
    const listResult = {
      ok: true,
      data: { items: [], nextCursor: null, truncated: false },
    } as const;
    const invoke = vi.fn((channel: string) =>
      Promise.resolve(channel === PROJECT_IPC_CHANNELS.list ? listResult : okDetail),
    );
    const api = createJingxuApi(invoke);
    const listInput = { scope: 'ACTIVE', limit: 20, cursor: null, search: null } as const;
    const getInput = { projectId: detail.id, scope: 'ACTIVE' } as const;
    const updateInput = {
      projectId: detail.id,
      expectedUpdatedAt: detail.updatedAt,
      requestId: 'request-update-0001',
      name: createInput.name,
      genre: createInput.genre,
      style: createInput.style,
      dialogueRenderMode: createInput.dialogueRenderMode,
      aspectRatio: createInput.aspectRatio,
      subtitleSafeArea: createInput.subtitleSafeArea,
    };
    const deleteInput = {
      projectId: detail.id,
      expectedUpdatedAt: detail.updatedAt,
      requestId: 'request-delete-0001',
    };
    const restoreInput = { ...deleteInput, requestId: 'request-restore-0001' };

    await expect(api.project.list(listInput)).resolves.toEqual(listResult);
    await expect(api.project.get(getInput)).resolves.toEqual(okDetail);
    await expect(api.project.create(createInput)).resolves.toEqual(okDetail);
    await expect(api.project.update(updateInput)).resolves.toEqual(okDetail);
    await expect(api.project.delete(deleteInput)).resolves.toEqual(okDetail);
    await expect(api.project.restore(restoreInput)).resolves.toEqual(okDetail);
    expect(invoke.mock.calls).toEqual([
      [PROJECT_IPC_CHANNELS.list, listInput],
      [PROJECT_IPC_CHANNELS.get, getInput],
      [PROJECT_IPC_CHANNELS.create, createInput],
      [PROJECT_IPC_CHANNELS.update, updateInput],
      [PROJECT_IPC_CHANNELS.delete, deleteInput],
      [PROJECT_IPC_CHANNELS.restore, restoreInput],
    ]);
  });

  it('Renderer 提交未知字段或机器字段—Preload 输入校验—invoke 零调用', async () => {
    const invoke = vi.fn();
    const api = createJingxuApi(invoke);

    await expect(
      api.project.create({ ...createInput, dataRootRel: 'C:\\secret' } as never),
    ).rejects.toThrow();
    await expect(api.project.create({ ...createInput, fps: 60 } as never)).rejects.toThrow();
    await expect(
      api.project.list({ scope: 'ACTIVE', limit: 101, cursor: null, search: null }),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('Main 返回未知字段或畸形 Result—Preload 输出校验—拒绝进入 Renderer', async () => {
    const api = createJingxuApi(
      vi.fn(() => Promise.resolve({ ok: true, data: { ...detail, sql: 'SELECT secret' } })),
    );

    await expect(api.project.create(createInput)).rejects.toThrow();
  });
});
