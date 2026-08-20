import { describe, expect, it, vi } from 'vitest';

import { STORYBOARD_IPC_CHANNELS } from '@jingxu/contracts';
import type { AppResultDto } from '@jingxu/contracts';
import type { StoryboardIpcService } from '../ipc/storyboard-ipc';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';
import { createStoryboardFeatureRegistration } from './register-storyboard-features';

const trustedEvent = () => {
  const frame = { url: 'jingxu://app/index.html' };
  return { sender: { mainFrame: frame }, senderFrame: frame };
};

const failure: AppResultDto<never> = {
  error: {
    code: 'PROJECT_PERSISTENCE_FAILED',
    fieldErrors: null,
    message: '测试桩失败',
    retryable: false,
    traceId: 'trace-stub-1',
    userAction: null,
  },
  ok: false,
};

const createHarness = (writeEnabled: boolean, storyboardAvailable = true) => {
  const handlers = new Map<
    string,
    (event: ReturnType<typeof trustedEvent>, ...arguments_: readonly unknown[]) => Promise<unknown>
  >();
  const service: StoryboardIpcService = {
    editShot: vi.fn(() => Promise.resolve(failure)),
    lockShot: vi.fn(() => Promise.resolve(failure)),
    unlockShot: vi.fn(() => Promise.resolve(failure)),
  };
  const createService = vi.fn(() => service);
  const unitOfWork = { run: vi.fn() };
  const registry = { schemaIds: [], validate: vi.fn() };
  let ready = writeEnabled;
  const runtime = {
    getSchemaRegistry: () => (storyboardAvailable ? registry : null),
    getScriptUnitOfWork: () => (storyboardAvailable ? unitOfWork : null),
    startupService: { getStatus: () => ({ writeEnabled: ready }) },
  } as unknown as DesktopPersistenceRuntime;
  const registration = createStoryboardFeatureRegistration({
    createService,
    ipcRegistrar: {
      handle: (channel, listener) => handlers.set(channel, listener),
    },
    newTraceId: () => 'trace-00000001',
    persistenceRuntime: runtime,
    trustedUrl: 'jingxu://app/index.html',
  });
  return {
    channels: [...handlers.keys()],
    createService,
    handlers,
    registration,
    registry,
    service,
    setReady: (value: boolean) => {
      ready = value;
    },
    unitOfWork,
  };
};

const editShotInput = {
  document: { narrative_purpose: '改写后的叙事目的' },
  episodeId: 'episode_12345678',
  expectedVersionId: 'epv_1234567890',
  projectId: 'project_12345678',
  requestId: 'request_edit_12345678',
  shotId: 'shot_1234567890',
  shotVersionId: 'scv_1234567890',
};

describe('createStoryboardFeatureRegistration', () => {
  it('条件—READY 且 Script Runtime 可用—只注册三个 storyboard.* 频道且只激活一次', () => {
    const harness = createHarness(true);
    expect(harness.registration.ensureRegistered()).toBe(true);
    expect(harness.registration.ensureRegistered()).toBe(false);
    expect(harness.channels.sort()).toEqual(Object.values(STORYBOARD_IPC_CHANNELS).sort());
    expect(harness.channels.every((channel) => channel.startsWith('storyboard.'))).toBe(true);
    expect(harness.createService).toHaveBeenCalledWith({
      registry: harness.registry,
      unitOfWork: harness.unitOfWork,
    });
  });

  it.each([
    ['启动未 READY', false, true],
    ['Script Runtime 不可用', true, false],
  ])('条件—%s—不构造 Service', (_label, ready, available) => {
    const harness = createHarness(ready, available);
    expect(harness.registration.ensureRegistered()).toBe(false);
    expect(harness.createService).not.toHaveBeenCalled();
  });

  it('激活前—启动门放行但 Service 未注入—facade 返回 STARTUP_WRITE_BLOCKED；激活后委托真实 Service', async () => {
    const harness = createHarness(true);
    const before = await harness.handlers.get(STORYBOARD_IPC_CHANNELS.editShot)?.(
      trustedEvent(),
      editShotInput,
    );
    // 门已 READY 但 ensureRegistered 尚未执行：blocked facade 兜底。
    expect(before).toMatchObject({ error: { code: 'STARTUP_WRITE_BLOCKED' }, ok: false });
    expect(harness.service.editShot).not.toHaveBeenCalled();

    expect(harness.registration.ensureRegistered()).toBe(true);
    await harness.handlers.get(STORYBOARD_IPC_CHANNELS.editShot)?.(trustedEvent(), editShotInput);
    expect(harness.service.editShot).toHaveBeenCalledWith(editShotInput, 'trace-00000001');
  });
});
