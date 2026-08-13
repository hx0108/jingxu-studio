import type {
  AppResultDto,
  CreateProjectInputDto,
  ProjectDetailDto,
  ProjectListResultDto,
} from '@jingxu/contracts';
import { PROJECT_IPC_CHANNELS } from '@jingxu/contracts';
import { describe, expect, it, vi } from 'vitest';

import { registerProjectIpc, type ProjectIpcEvent, type ProjectIpcService } from './project-ipc';

const TRUSTED_URL = 'jingxu://app/index.html';
const TRACE_ID = 'trace_project_0001';

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

const listResult: ProjectListResultDto = {
  items: [],
  nextCursor: null,
  truncated: false,
};

const okDetail = { ok: true, data: detail } as const satisfies AppResultDto<ProjectDetailDto>;
const okList = { ok: true, data: listResult } as const satisfies AppResultDto<ProjectListResultDto>;

const trustedEvent = (): ProjectIpcEvent => {
  const frame = { url: TRUSTED_URL };
  return { sender: { mainFrame: frame }, senderFrame: frame };
};

const createHarness = (options: { readonly ready?: boolean } = {}) => {
  const handlers = new Map<
    string,
    (event: ProjectIpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>
  >();
  const service = {
    list: vi.fn(() => Promise.resolve(okList)),
    get: vi.fn(() => Promise.resolve(okDetail)),
    create: vi.fn(() => Promise.resolve(okDetail)),
    update: vi.fn(() => Promise.resolve(okDetail)),
    delete: vi.fn(() => Promise.resolve(okDetail)),
    restore: vi.fn(() => Promise.resolve(okDetail)),
  } satisfies ProjectIpcService;

  registerProjectIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    service,
    { isWriteReady: () => options.ready ?? true },
    TRUSTED_URL,
    { newTraceId: () => TRACE_ID },
  );
  return { handlers, service };
};

describe('project IPC Contract', () => {
  it('注册 Project Host—检查频道—恰有六条固定白名单', () => {
    const { handlers } = createHarness();

    expect([...handlers.keys()].sort()).toEqual(Object.values(PROJECT_IPC_CHANNELS).sort());
  });

  it('受信主 frame 调用—六个合法 DTO—逐方法委托并传入 traceId', async () => {
    const { handlers, service } = createHarness();
    const getInput = { projectId: detail.id, scope: 'ACTIVE' } as const;
    const listInput = { scope: 'ACTIVE', limit: 20, cursor: null, search: null } as const;
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

    await expect(
      handlers.get(PROJECT_IPC_CHANNELS.list)?.(trustedEvent(), listInput),
    ).resolves.toEqual(okList);
    await expect(
      handlers.get(PROJECT_IPC_CHANNELS.get)?.(trustedEvent(), getInput),
    ).resolves.toEqual(okDetail);
    await expect(
      handlers.get(PROJECT_IPC_CHANNELS.create)?.(trustedEvent(), createInput),
    ).resolves.toEqual(okDetail);
    await expect(
      handlers.get(PROJECT_IPC_CHANNELS.update)?.(trustedEvent(), updateInput),
    ).resolves.toEqual(okDetail);
    await expect(
      handlers.get(PROJECT_IPC_CHANNELS.delete)?.(trustedEvent(), deleteInput),
    ).resolves.toEqual(okDetail);
    await expect(
      handlers.get(PROJECT_IPC_CHANNELS.restore)?.(trustedEvent(), restoreInput),
    ).resolves.toEqual(okDetail);

    expect(service.list).toHaveBeenCalledWith(listInput, TRACE_ID);
    expect(service.get).toHaveBeenCalledWith(getInput, TRACE_ID);
    expect(service.create).toHaveBeenCalledWith(createInput, TRACE_ID);
    expect(service.update).toHaveBeenCalledWith(updateInput, TRACE_ID);
    expect(service.delete).toHaveBeenCalledWith(deleteInput, TRACE_ID);
    expect(service.restore).toHaveBeenCalledWith(restoreInput, TRACE_ID);
  });

  it('子 frame 或外部 URL—调用 Project Host—直接拒绝且不触发服务', async () => {
    const { handlers, service } = createHarness();
    const mainFrame = { url: TRUSTED_URL };
    const invalidEvents: ProjectIpcEvent[] = [
      { sender: { mainFrame }, senderFrame: { url: TRUSTED_URL } },
      {
        sender: { mainFrame: { url: 'https://evil.example/' } },
        senderFrame: { url: 'https://evil.example/' },
      },
      { sender: { mainFrame }, senderFrame: null },
    ];

    for (const event of invalidEvents) {
      await expect(
        Promise.resolve().then(() =>
          handlers.get(PROJECT_IPC_CHANNELS.create)?.(event, createInput),
        ),
      ).rejects.toThrow('IPC_SENDER_NOT_ALLOWED');
    }
    expect(service.create).not.toHaveBeenCalled();
  });

  it('受信 sender 提交多余参数、未知字段或机器字段—严格校验—返回脱敏非法请求', async () => {
    const { handlers, service } = createHarness();
    const attacks: readonly (readonly unknown[])[] = [
      [],
      [createInput, 'extra'],
      [{ ...createInput, unknown: true }],
      [{ ...createInput, dataRootRel: 'C:\\Users\\ASUS\\secret' }],
      [{ ...createInput, fps: 60, sql: 'SELECT * FROM projects' }],
    ];

    for (const arguments_ of attacks) {
      const result = await handlers.get(PROJECT_IPC_CHANNELS.create)?.(
        trustedEvent(),
        ...arguments_,
      );
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'IPC_INVALID_REQUEST',
          message: '请求参数无效',
          retryable: false,
          userAction: '请检查输入后重试',
          fieldErrors: null,
          traceId: TRACE_ID,
        },
      });
      expect(JSON.stringify(result)).not.toContain('SELECT');
      expect(JSON.stringify(result)).not.toContain('C:');
    }
    expect(service.create).not.toHaveBeenCalled();
  });

  it('启动状态非 READY—调用四个写命令—写门阻断且服务零调用', async () => {
    const { handlers, service } = createHarness({ ready: false });
    const mutation = {
      projectId: detail.id,
      expectedUpdatedAt: detail.updatedAt,
      requestId: 'request-delete-0001',
    };

    for (const [channel, input] of [
      [PROJECT_IPC_CHANNELS.create, createInput],
      [
        PROJECT_IPC_CHANNELS.update,
        {
          projectId: detail.id,
          expectedUpdatedAt: detail.updatedAt,
          requestId: 'request-update-0001',
          name: createInput.name,
          genre: createInput.genre,
          style: createInput.style,
          dialogueRenderMode: createInput.dialogueRenderMode,
          aspectRatio: createInput.aspectRatio,
          subtitleSafeArea: createInput.subtitleSafeArea,
        },
      ],
      [PROJECT_IPC_CHANNELS.delete, mutation],
      [PROJECT_IPC_CHANNELS.restore, { ...mutation, requestId: 'request-restore-0001' }],
    ] as const) {
      await expect(handlers.get(channel)?.(trustedEvent(), input)).resolves.toMatchObject({
        ok: false,
        error: { code: 'STARTUP_WRITE_BLOCKED', traceId: TRACE_ID },
      });
    }
    expect(service.create).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.restore).not.toHaveBeenCalled();
  });

  it('服务返回畸形结果或抛内部异常—输出校验失败—归一为零泄漏错误', async () => {
    const { handlers, service } = createHarness();
    service.create.mockResolvedValueOnce({ ok: true, data: { sql: 'SELECT secret' } } as never);
    service.create.mockRejectedValueOnce(
      new Error('SQLITE_CONSTRAINT at C:\\Users\\ASUS\\project.db SELECT * FROM projects'),
    );

    for (let index = 0; index < 2; index += 1) {
      const result = await handlers.get(PROJECT_IPC_CHANNELS.create)?.(trustedEvent(), {
        ...createInput,
        requestId: `request-create-${String(index + 20)}`,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'PROJECT_PERSISTENCE_FAILED', retryable: true },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('SELECT');
      expect(serialized).not.toContain('C:');
      expect(serialized).not.toContain('SQLITE');
    }
  });

  it('相同 requestId 同时到达—Main singleflight—只执行一次并共享 Promise 结果', async () => {
    const { handlers, service } = createHarness();
    let release: ((value: typeof okDetail | PromiseLike<typeof okDetail>) => void) | undefined;
    service.create.mockImplementationOnce(
      () =>
        new Promise<typeof okDetail>((resolve) => {
          release = resolve;
        }),
    );

    const first = handlers.get(PROJECT_IPC_CHANNELS.create)?.(trustedEvent(), createInput);
    const second = handlers.get(PROJECT_IPC_CHANNELS.create)?.(trustedEvent(), createInput);
    await Promise.resolve();
    expect(service.create).toHaveBeenCalledTimes(1);
    release?.(okDetail);

    await expect(first).resolves.toEqual(okDetail);
    await expect(second).resolves.toEqual(okDetail);
  });

  it('相同 requestId 不同载荷同时到达—Main 协调器—拒绝复用且不执行第二次', async () => {
    const { handlers, service } = createHarness();
    let release: ((value: typeof okDetail | PromiseLike<typeof okDetail>) => void) | undefined;
    service.create.mockImplementationOnce(
      () =>
        new Promise<typeof okDetail>((resolve) => {
          release = resolve;
        }),
    );

    const first = handlers.get(PROJECT_IPC_CHANNELS.create)?.(trustedEvent(), createInput);
    const conflict = await handlers.get(PROJECT_IPC_CHANNELS.create)?.(trustedEvent(), {
      ...createInput,
      name: '另一项目',
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: 'REQUEST_ID_REUSED', traceId: TRACE_ID },
    });
    expect(service.create).toHaveBeenCalledTimes(1);
    release?.(okDetail);
    await expect(first).resolves.toEqual(okDetail);
  });
});
