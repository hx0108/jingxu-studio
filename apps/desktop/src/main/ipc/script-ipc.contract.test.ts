import { describe, expect, it, vi } from 'vitest';

import { SCRIPT_IPC_CHANNELS } from '@jingxu/contracts';
import type { AppResultDto, ScriptVersionDto, ScriptWorkspaceDto } from '@jingxu/contracts';
import type { ScriptIpcService } from './script-ipc';
import { registerScriptIpc } from './script-ipc';

const trustedEvent = () => {
  const frame = { url: 'jingxu://app/index.html' };
  return { sender: { mainFrame: frame }, senderFrame: frame };
};

const version: ScriptVersionDto = {
  createdAt: '2026-08-13T00:00:00.000Z',
  document: {
    data: { title: '雾都来信' },
    episode_id: null,
    project_id: 'project_12345678',
    schema_version: '1.0.0' as const,
    source_invocation_id: 'invocation_12345678',
    stage: 'CONCEPT' as const,
  },
  documentHash: 'a'.repeat(64),
  id: 'version_12345678',
  parentId: null,
  projectId: 'project_12345678',
  source: 'AI' as const,
  status: 'DRAFT' as const,
  versionNo: 1,
};

const workspace: ScriptWorkspaceDto = {
  currentJob: null,
  episode: {
    id: 'episode_12345678',
    projectId: 'project_12345678',
    targetDurationSec: 90,
    title: '第 1 集',
  },
  prerequisites: [{ message: '可以生成', ready: true, stage: 'CONCEPT' as const }],
  projectId: 'project_12345678',
  source: {
    characterCount: 24,
    contentHash: 'b'.repeat(64),
    creativeText: '一封来自未来的信改变了侦探原本平静而孤独的一天。',
    id: 'source_12345678',
    projectId: 'project_12345678',
  },
  storyboard: { current: null, history: [], shots: [], totalDurationSec: 0 },
  stages: [
    { current: version, history: [version], prerequisiteReady: true, stage: 'CONCEPT' as const },
  ],
};
const okVersion: AppResultDto<ScriptVersionDto> = { data: version, ok: true };
const okWorkspace: AppResultDto<ScriptWorkspaceDto> = { data: workspace, ok: true };

const commands = {
  initializeOriginal: {
    creativeText: workspace.source.creativeText,
    dataProcessingConsent: true as const,
    projectId: workspace.projectId,
    requestId: 'request_initialize_12345678',
  },
  saveDraft: {
    data: { title: '新标题' },
    episodeId: null,
    expectedVersionId: version.id,
    projectId: workspace.projectId,
    requestId: 'request_save_12345678',
    stage: 'CONCEPT' as const,
  },
  confirmVersion: {
    episodeId: null,
    expectedVersionId: version.id,
    projectId: workspace.projectId,
    requestId: 'request_confirm_12345678',
    stage: 'CONCEPT' as const,
    versionId: version.id,
  },
  restoreVersion: {
    episodeId: null,
    expectedVersionId: version.id,
    projectId: workspace.projectId,
    requestId: 'request_restore_12345678',
    stage: 'CONCEPT' as const,
    versionId: version.id,
  },
};

const createHarness = (ready = true) => {
  const handlers = new Map<
    string,
    (event: ReturnType<typeof trustedEvent>, ...arguments_: readonly unknown[]) => Promise<unknown>
  >();
  const service: ScriptIpcService = {
    confirmVersion: vi.fn(() => Promise.resolve(okVersion)),
    getWorkspace: vi.fn(() => Promise.resolve(okWorkspace)),
    initializeOriginal: vi.fn(() => Promise.resolve(okWorkspace)),
    lockPath: vi.fn(() =>
      Promise.resolve({
        data: {
          lockedPaths: [],
          objectType: 'SCRIPT_VERSION' as const,
          objectVersionId: version.id,
        },
        ok: true as const,
      }),
    ),
    listLocks: vi.fn(() =>
      Promise.resolve({
        data: {
          lockedPaths: [],
          objectType: 'SCRIPT_VERSION' as const,
          objectVersionId: version.id,
        },
        ok: true as const,
      }),
    ),
    restoreVersion: vi.fn(() => Promise.resolve(okVersion)),
    saveDraft: vi.fn(() => Promise.resolve(okVersion)),
  };
  registerScriptIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    service,
    { isWriteReady: () => ready },
    'jingxu://app/index.html',
    { newTraceId: () => 'trace_script_12345678' },
  );
  return { handlers, service };
};

describe('Script Main IPC Contract', () => {
  it('注册边界—固定五方法—可信 sender 与 strict DTO 后委托 Application', async () => {
    const { handlers, service } = createHarness();
    expect([...handlers.keys()].sort()).toEqual(Object.values(SCRIPT_IPC_CHANNELS).sort());

    await expect(
      handlers.get(SCRIPT_IPC_CHANNELS.getWorkspace)?.(trustedEvent(), {
        projectId: workspace.projectId,
      }),
    ).resolves.toEqual({ data: workspace, ok: true });
    await expect(
      handlers.get(SCRIPT_IPC_CHANNELS.initializeOriginal)?.(
        trustedEvent(),
        commands.initializeOriginal,
      ),
    ).resolves.toEqual({ data: workspace, ok: true });
    expect(service.getWorkspace).toHaveBeenCalledWith(
      { projectId: workspace.projectId },
      'trace_script_12345678',
    );
  });

  it('非 READY—四个写命令统一阻断—Service 零调用', async () => {
    const { handlers, service } = createHarness(false);
    for (const [method, input] of Object.entries(commands)) {
      await expect(
        handlers.get(SCRIPT_IPC_CHANNELS[method as keyof typeof SCRIPT_IPC_CHANNELS])?.(
          trustedEvent(),
          input,
        ),
      ).resolves.toMatchObject({ error: { code: 'STARTUP_WRITE_BLOCKED' }, ok: false });
    }
    expect(service.initializeOriginal).not.toHaveBeenCalled();
    expect(service.saveDraft).not.toHaveBeenCalled();
    expect(service.confirmVersion).not.toHaveBeenCalled();
    expect(service.restoreVersion).not.toHaveBeenCalled();
  });

  it('未知字段、额外参数与跨层级 episode—输入拒绝—Service 零调用', async () => {
    const { handlers, service } = createHarness();
    const handle = handlers.get(SCRIPT_IPC_CHANNELS.saveDraft);
    await expect(
      handle?.(trustedEvent(), { ...commands.saveDraft, sql: 'SELECT secret' }),
    ).resolves.toMatchObject({ error: { code: 'IPC_INVALID_REQUEST' } });
    await expect(handle?.(trustedEvent(), commands.saveDraft, 'extra')).resolves.toMatchObject({
      error: { code: 'IPC_INVALID_REQUEST' },
    });
    await expect(
      handle?.(trustedEvent(), { ...commands.saveDraft, episodeId: 'episode_12345678' }),
    ).resolves.toMatchObject({ error: { code: 'IPC_INVALID_REQUEST' } });
    expect(service.saveDraft).not.toHaveBeenCalled();
  });

  it('不可信 frame—边界直接拒绝—Service 零调用', () => {
    const { handlers, service } = createHarness();
    const event = trustedEvent();
    expect(() =>
      handlers.get(SCRIPT_IPC_CHANNELS.getWorkspace)?.(
        { ...event, senderFrame: { url: 'https://evil.example/' } },
        { projectId: workspace.projectId },
      ),
    ).toThrow('IPC_SENDER_NOT_ALLOWED');
    expect(service.getWorkspace).not.toHaveBeenCalled();
  });

  it('同 requestId 并发同命令—singleflight 同结果—Application 只调用一次', async () => {
    const { handlers, service } = createHarness();
    let finish: ((value: { data: typeof version; ok: true }) => void) | undefined;
    vi.mocked(service.saveDraft).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const handle = handlers.get(SCRIPT_IPC_CHANNELS.saveDraft);
    const first = handle?.(trustedEvent(), commands.saveDraft);
    const second = handle?.(trustedEvent(), commands.saveDraft);
    await vi.waitFor(() => {
      expect(service.saveDraft).toHaveBeenCalledOnce();
    });
    finish?.(okVersion);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { data: version, ok: true },
      { data: version, ok: true },
    ]);
    expect(service.saveDraft).toHaveBeenCalledOnce();
  });

  it('同 requestId 并发不同命令—返回 REQUEST_ID_REUSED—不执行第二次写入', async () => {
    const { handlers, service } = createHarness();
    let finish: ((value: { data: typeof version; ok: true }) => void) | undefined;
    vi.mocked(service.saveDraft).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const first = handlers.get(SCRIPT_IPC_CHANNELS.saveDraft)?.(trustedEvent(), commands.saveDraft);
    await vi.waitFor(() => {
      expect(service.saveDraft).toHaveBeenCalledOnce();
    });
    const conflict = {
      ...commands.confirmVersion,
      requestId: commands.saveDraft.requestId,
    };
    await expect(
      handlers.get(SCRIPT_IPC_CHANNELS.confirmVersion)?.(trustedEvent(), conflict),
    ).resolves.toMatchObject({ error: { code: 'REQUEST_ID_REUSED' }, ok: false });
    finish?.(okVersion);
    await first;
    expect(service.confirmVersion).not.toHaveBeenCalled();
  });

  it('Service throw 或畸形输出—统一脱敏错误—零路径、SQL、原文、Key、响应泄漏', async () => {
    const { handlers, service } = createHarness();
    vi.mocked(service.getWorkspace).mockRejectedValue(
      new Error('C:\\Users\\secret SELECT * apiKey=sk-secret raw response full creative'),
    );
    const result = await handlers.get(SCRIPT_IPC_CHANNELS.getWorkspace)?.(trustedEvent(), {
      projectId: workspace.projectId,
    });
    expect(result).toMatchObject({ error: { code: 'PROJECT_PERSISTENCE_FAILED' }, ok: false });
    const serialized = JSON.stringify(result);
    for (const secret of ['C:\\', 'SELECT', 'sk-secret', 'raw response', 'full creative']) {
      expect(serialized).not.toContain(secret);
    }
  });
});
