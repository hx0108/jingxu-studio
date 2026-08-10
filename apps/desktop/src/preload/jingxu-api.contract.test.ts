import {
  PROJECT_IPC_CHANNELS,
  type AppResultDto,
  type CreateProjectInputDto,
  type JingxuApi,
  type ProjectDetailDto,
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
    expect(Object.keys(api)).toEqual(['runtime', 'project']);
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

  it.each(['send', 'on', 'once', 'invoke'])(
    '检查 %s—Preload、runtime 与 project 均不提供通用频道入口',
    (methodName) => {
      const api = createJingxuApi(vi.fn());
      expect(Reflect.has(api, methodName)).toBe(false);
      expect(Reflect.has(api.runtime, methodName)).toBe(false);
      expect(Reflect.has(api.project, methodName)).toBe(false);
    },
  );

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
