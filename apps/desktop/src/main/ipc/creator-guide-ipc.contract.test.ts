import type {
  AppResultDto,
  CreatorDemoResultDto,
  CreatorNextActionResultDto,
} from '@jingxu/contracts';
import { CREATOR_GUIDE_IPC_CHANNELS } from '@jingxu/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  registerCreatorGuideIpc,
  type CreatorGuideIpcEvent,
  type CreatorGuideIpcService,
} from './creator-guide-ipc';

const TRUSTED_URL = 'jingxu://app/index.html';
const TRACE_ID = 'trace_creator_0001';
const PROJECT_ID = 'project_12345678';

const okResult = {
  ok: true,
  data: {
    action: 'ENTER_STORY',
    blocked: false,
    fixAction: null,
    projectId: PROJECT_ID,
    reason: '先写下故事创意或导入已有内容',
    stage: null,
    target: 'SOURCE_INPUT',
    title: '输入本集故事',
  },
} as const satisfies AppResultDto<CreatorNextActionResultDto>;

const demoResult = {
  ok: true,
  data: {
    isDemo: true,
    projectId: PROJECT_ID,
    resumed: false,
    summary: '示例剧本与分镜已就绪，接下来生成画面。',
  },
} as const satisfies AppResultDto<CreatorDemoResultDto>;

const trustedEvent = (): CreatorGuideIpcEvent => {
  const frame = { url: TRUSTED_URL };
  return { sender: { mainFrame: frame }, senderFrame: frame };
};

const createHarness = () => {
  const handlers = new Map<
    string,
    (event: CreatorGuideIpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>
  >();
  const service = {
    getNextAction: vi.fn(() => Promise.resolve(okResult)),
    startDemo: vi.fn(() => Promise.resolve(demoResult)),
  } satisfies CreatorGuideIpcService;
  registerCreatorGuideIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    service,
    TRUSTED_URL,
    { newTraceId: () => TRACE_ID },
  );
  return { handlers, service };
};

describe('creator guide IPC Contract', () => {
  it('受信主 frame 调用—合法查询—逐方法委托且返回 strict 结果', async () => {
    const { handlers, service } = createHarness();

    await expect(
      handlers.get(CREATOR_GUIDE_IPC_CHANNELS.getNextAction)?.(trustedEvent(), {
        projectId: PROJECT_ID,
      }),
    ).resolves.toEqual(okResult);
    expect(service.getNextAction).toHaveBeenCalledWith({ projectId: PROJECT_ID }, TRACE_ID);

    await expect(
      handlers.get(CREATOR_GUIDE_IPC_CHANNELS.startDemo)?.(trustedEvent(), {
        requestId: 'request_demo0001',
      }),
    ).resolves.toEqual(demoResult);
    expect(service.startDemo).toHaveBeenCalledWith({ requestId: 'request_demo0001' }, TRACE_ID);
  });

  it('未知字段、多参数或越界标识—严格校验—返回稳定错误且服务零调用', async () => {
    const { handlers, service } = createHarness();
    const attacks: readonly (readonly unknown[])[] = [
      [],
      [{ projectId: PROJECT_ID, provider: 'secret' }],
      [{ projectId: '../project_other' }],
      [{ projectId: PROJECT_ID }, 'extra'],
    ];

    for (const arguments_ of attacks) {
      await expect(
        handlers.get(CREATOR_GUIDE_IPC_CHANNELS.getNextAction)?.(trustedEvent(), ...arguments_),
      ).resolves.toMatchObject({ ok: false, error: { code: 'IPC_INVALID_REQUEST' } });
    }
    expect(service.getNextAction).not.toHaveBeenCalled();
    await expect(
      handlers.get(CREATOR_GUIDE_IPC_CHANNELS.startDemo)?.(trustedEvent(), {
        requestId: 'short',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'IPC_INVALID_REQUEST' } });
    expect(service.startDemo).not.toHaveBeenCalled();
  });

  it('外部 URL 调用—sender 边界阻断—服务零调用', async () => {
    const { handlers, service } = createHarness();
    const frame = { url: 'https://evil.example/' };

    await expect(
      Promise.resolve().then(() =>
        handlers.get(CREATOR_GUIDE_IPC_CHANNELS.getNextAction)?.(
          { sender: { mainFrame: frame }, senderFrame: frame },
          { projectId: PROJECT_ID },
        ),
      ),
    ).rejects.toThrow('IPC_SENDER_NOT_ALLOWED');
    expect(service.getNextAction).not.toHaveBeenCalled();
  });

  it('服务返回畸形结果—输出校验失败—归一为脱敏错误', async () => {
    const { handlers, service } = createHarness();
    service.getNextAction.mockResolvedValueOnce({ ok: true, data: { provider: 'leak' } } as never);

    const result = await handlers.get(CREATOR_GUIDE_IPC_CHANNELS.getNextAction)?.(trustedEvent(), {
      projectId: null,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'PROJECT_PERSISTENCE_FAILED' } });
    expect(JSON.stringify(result)).not.toContain('provider');
  });
});
