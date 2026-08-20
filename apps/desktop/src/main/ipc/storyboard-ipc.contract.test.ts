import { describe, expect, it, vi } from 'vitest';

import { STORYBOARD_IPC_CHANNELS } from '@jingxu/contracts';
import type {
  AppResultDto,
  ShotEditLockSummaryDto,
  StoryboardExportResultDto,
} from '@jingxu/contracts';
import type { StoryboardIpcService } from './storyboard-ipc';
import { registerStoryboardIpc } from './storyboard-ipc';

const trustedEvent = () => {
  const frame = { url: 'jingxu://app/index.html' };
  return { sender: { mainFrame: frame }, senderFrame: frame };
};

const summary: ShotEditLockSummaryDto = {
  episode: {
    createdAt: '2026-08-20T00:00:00.000Z',
    episodeId: 'episode_12345678',
    formatProfileId: 'format_12345678',
    id: 'epv_1234567890',
    parentId: null,
    shotCount: 2,
    shotSetHash: 'a'.repeat(64),
    status: 'DRAFT' as const,
    storyBibleVersionId: 'bible_1234567',
    targetDurationSec: 30,
    versionNo: 2,
  },
  lockedPaths: [],
  shotVersionId: 'scv_1234567890',
};
const okSummary: AppResultDto<ShotEditLockSummaryDto> = { data: summary, ok: true };

const okExport: AppResultDto<StoryboardExportResultDto> = {
  data: {
    byteSize: 20480,
    episodeVersionId: summary.episode.id,
    exportId: 'export_12345678',
    fileSha256: 'a'.repeat(64),
    totalDurationSec: 90,
  },
  ok: true,
};

const commands = {
  editShot: {
    document: { narrative_purpose: '改写后的叙事目的', target_duration_sec: 12 },
    episodeId: summary.episode.episodeId,
    expectedVersionId: summary.episode.id,
    projectId: 'project_12345678',
    requestId: 'request_edit_12345678',
    shotId: 'shot_1234567890',
    shotVersionId: summary.shotVersionId,
  },
  lockShot: {
    episodeId: summary.episode.episodeId,
    expectedVersionId: summary.episode.id,
    jsonPointer: '/dialogue',
    note: '台词定稿',
    projectId: 'project_12345678',
    requestId: 'request_lock_12345678',
    shotId: 'shot_1234567890',
  },
  unlockShot: {
    episodeId: summary.episode.episodeId,
    expectedVersionId: summary.episode.id,
    jsonPointer: '/dialogue',
    projectId: 'project_12345678',
    requestId: 'request_unlock_1234567',
    shotId: 'shot_1234567890',
  },
  exportEpisode: {
    episodeId: summary.episode.episodeId,
    expectedVersionId: summary.episode.id,
    // deliverables D1：IPC 边界 parse 后 format 缺省回填 EPISODE_JSON 传入服务。
    format: 'EPISODE_JSON',
    projectId: 'project_12345678',
    requestId: 'request_export_123456',
  },
};

const createHarness = (ready = true) => {
  const handlers = new Map<
    string,
    (event: ReturnType<typeof trustedEvent>, ...arguments_: readonly unknown[]) => Promise<unknown>
  >();
  const service: StoryboardIpcService = {
    editShot: vi.fn(() => Promise.resolve(okSummary)),
    exportEpisode: vi.fn(() => Promise.resolve(okExport)),
    lockShot: vi.fn(() => Promise.resolve(okSummary)),
    unlockShot: vi.fn(() => Promise.resolve(okSummary)),
  };
  registerStoryboardIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    service,
    { isWriteReady: () => ready },
    'jingxu://app/index.html',
    { newTraceId: () => 'trace_storyboard_1234' },
  );
  return { handlers, service };
};

describe('Storyboard Main IPC Contract（shot-edit-lock 3.2）', () => {
  it('注册边界—固定四方法—可信 sender 与 strict DTO 后委托 Application', async () => {
    const { handlers, service } = createHarness();
    expect([...handlers.keys()].sort()).toEqual(Object.values(STORYBOARD_IPC_CHANNELS).sort());

    await expect(
      handlers.get(STORYBOARD_IPC_CHANNELS.editShot)?.(trustedEvent(), commands.editShot),
    ).resolves.toEqual(okSummary);
    await expect(
      handlers.get(STORYBOARD_IPC_CHANNELS.lockShot)?.(trustedEvent(), commands.lockShot),
    ).resolves.toEqual(okSummary);
    await expect(
      handlers.get(STORYBOARD_IPC_CHANNELS.unlockShot)?.(trustedEvent(), commands.unlockShot),
    ).resolves.toEqual(okSummary);
    await expect(
      handlers.get(STORYBOARD_IPC_CHANNELS.exportEpisode)?.(trustedEvent(), commands.exportEpisode),
    ).resolves.toEqual(okExport);
    expect(service.editShot).toHaveBeenCalledWith(commands.editShot, 'trace_storyboard_1234');
    expect(service.exportEpisode).toHaveBeenCalledWith(
      commands.exportEpisode,
      'trace_storyboard_1234',
    );
    expect(service.lockShot).toHaveBeenCalledWith(commands.lockShot, 'trace_storyboard_1234');
    expect(service.unlockShot).toHaveBeenCalledWith(commands.unlockShot, 'trace_storyboard_1234');
  });

  it('非 READY—四个写命令统一阻断—Service 零调用', async () => {
    const { handlers, service } = createHarness(false);
    for (const [method, input] of Object.entries(commands)) {
      await expect(
        handlers.get(STORYBOARD_IPC_CHANNELS[method as keyof typeof STORYBOARD_IPC_CHANNELS])?.(
          trustedEvent(),
          input,
        ),
      ).resolves.toMatchObject({ error: { code: 'STARTUP_WRITE_BLOCKED' }, ok: false });
    }
    expect(service.editShot).not.toHaveBeenCalled();
    expect(service.lockShot).not.toHaveBeenCalled();
    expect(service.unlockShot).not.toHaveBeenCalled();
  });

  it('未知字段、额外参数与空指针—输入拒绝—Service 零调用', async () => {
    const { handlers, service } = createHarness();
    const handle = handlers.get(STORYBOARD_IPC_CHANNELS.lockShot);
    await expect(
      handle?.(trustedEvent(), { ...commands.lockShot, lockedBy: 'USER' }),
    ).resolves.toMatchObject({ error: { code: 'IPC_INVALID_REQUEST' } });
    await expect(handle?.(trustedEvent(), commands.lockShot, 'extra')).resolves.toMatchObject({
      error: { code: 'IPC_INVALID_REQUEST' },
    });
    await expect(
      handlers.get(STORYBOARD_IPC_CHANNELS.editShot)?.(trustedEvent(), {
        ...commands.editShot,
        status: 'READY',
      }),
    ).resolves.toMatchObject({ error: { code: 'IPC_INVALID_REQUEST' } });
    await expect(
      handle?.(trustedEvent(), { ...commands.lockShot, jsonPointer: '' }),
    ).resolves.toMatchObject({ error: { code: 'IPC_INVALID_REQUEST' } });
    expect(service.editShot).not.toHaveBeenCalled();
    expect(service.lockShot).not.toHaveBeenCalled();
    expect(service.unlockShot).not.toHaveBeenCalled();
  });

  it('不可信 frame—边界直接拒绝—Service 零调用', () => {
    const { handlers, service } = createHarness();
    const event = trustedEvent();
    expect(() =>
      handlers.get(STORYBOARD_IPC_CHANNELS.editShot)?.(
        { ...event, senderFrame: { url: 'https://evil.example/' } },
        commands.editShot,
      ),
    ).toThrow('IPC_SENDER_NOT_ALLOWED');
    expect(service.editShot).not.toHaveBeenCalled();
  });

  it('同 requestId 并发同命令—singleflight 同结果—Application 只调用一次', async () => {
    const { handlers, service } = createHarness();
    let finish: ((value: AppResultDto<ShotEditLockSummaryDto>) => void) | undefined;
    vi.mocked(service.lockShot).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const handle = handlers.get(STORYBOARD_IPC_CHANNELS.lockShot);
    const first = handle?.(trustedEvent(), commands.lockShot);
    const second = handle?.(trustedEvent(), commands.lockShot);
    await vi.waitFor(() => {
      expect(service.lockShot).toHaveBeenCalledOnce();
    });
    finish?.(okSummary);
    await expect(Promise.all([first, second])).resolves.toEqual([okSummary, okSummary]);
    expect(service.lockShot).toHaveBeenCalledOnce();
  });

  it('同 requestId 并发不同命令—返回 REQUEST_ID_REUSED—不执行第二次写入', async () => {
    const { handlers, service } = createHarness();
    let finish: ((value: AppResultDto<ShotEditLockSummaryDto>) => void) | undefined;
    vi.mocked(service.editShot).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const first = handlers.get(STORYBOARD_IPC_CHANNELS.editShot)?.(
      trustedEvent(),
      commands.editShot,
    );
    await vi.waitFor(() => {
      expect(service.editShot).toHaveBeenCalledOnce();
    });
    const conflict = { ...commands.lockShot, requestId: commands.editShot.requestId };
    await expect(
      handlers.get(STORYBOARD_IPC_CHANNELS.lockShot)?.(trustedEvent(), conflict),
    ).resolves.toMatchObject({ error: { code: 'REQUEST_ID_REUSED' }, ok: false });
    finish?.(okSummary);
    await first;
    expect(service.lockShot).not.toHaveBeenCalled();
  });

  it('Service throw 或畸形输出—统一脱敏错误—零路径、SQL、原文泄漏', async () => {
    const { handlers, service } = createHarness();
    vi.mocked(service.editShot).mockRejectedValue(
      new Error('C:\\Users\\secret SELECT * document_snippet raw'),
    );
    const result = await handlers.get(STORYBOARD_IPC_CHANNELS.editShot)?.(
      trustedEvent(),
      commands.editShot,
    );
    expect(result).toMatchObject({ error: { code: 'PROJECT_PERSISTENCE_FAILED' }, ok: false });
    const serialized = JSON.stringify(result);
    for (const secret of ['C:\\', 'SELECT', 'document_snippet', 'raw']) {
      expect(serialized).not.toContain(secret);
    }
  });
});
