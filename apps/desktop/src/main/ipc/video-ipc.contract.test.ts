import { describe, expect, it, vi } from 'vitest';

import { VIDEO_IPC_CHANNELS } from '@jingxu/contracts';
import type {
  AppResultDto,
  MediaBatchViewDto,
  MediaTaskViewDto,
  StoryboardVideoStatesDto,
  VideoCandidateViewDto,
} from '@jingxu/contracts';
import type { VideoIpcService } from './video-ipc';
import { registerVideoIpc } from './video-ipc';

const trustedEvent = () => {
  const frame = { url: 'jingxu://app/index.html' };
  return { sender: { mainFrame: frame }, senderFrame: frame };
};

/** 合法 64 位十六进制（契约 hashSchema 只认 [a-f0-9]{64}）。 */
const hash64 = (seed: string): string => String(seed.length % 10).repeat(64);
const NOW = '2026-08-16T00:00:00.000Z';

const task: MediaTaskViewDto = {
  candidateCount: 2,
  createdAt: NOW,
  errorCode: null,
  generationInputHash: hash64('gen'),
  id: 'task_12345678',
  phase: 'SUBMITTED',
  shotId: 'shot_12345678',
  shotVersionId: 'scv_12345678',
  updatedAt: NOW,
};

const candidate: VideoCandidateViewDto = {
  actualDurationSec: null,
  byteSize: null,
  continuationSegmentCount: 0,
  createdAt: NOW,
  errorCode: null,
  firstFrameCandidateId: 'cand_12345678',
  generationInputHash: hash64('gen'),
  height: null,
  id: 'vcand_12345678',
  indexInRound: 0,
  mediaUrl: null,
  mimeType: null,
  requestedDurationSec: 8,
  roundNo: 1,
  selectedAt: null,
  shotId: 'shot_12345678',
  shotVersionId: 'scv_12345678',
  status: 'PENDING',
  trimRange: null,
  width: null,
};

const okTask: AppResultDto<MediaTaskViewDto> = { data: task, ok: true };
const okCandidates: AppResultDto<VideoCandidateViewDto[]> = { data: [candidate], ok: true };

const batchView: MediaBatchViewDto = {
  batchId: 'batch_12345678',
  createdAt: NOW,
  errorCode: null,
  members: [
    { errorCode: null, phase: null, shotId: 'shot_12345678', taskId: null },
    {
      errorCode: null,
      phase: 'COMPLETED',
      shotId: 'shot_87654321',
      taskId: 'task_87654321',
    },
  ],
  skippedShotIds: [],
  status: 'RUNNING',
  updatedAt: NOW,
};
const okBatch: AppResultDto<MediaBatchViewDto> = { data: batchView, ok: true };
const okStates: AppResultDto<StoryboardVideoStatesDto> = {
  data: {
    batches: [batchView],
    shots: [
      {
        activeTaskPhase: null,
        currentGenSucceededCount: 0,
        latestTaskErrorCode: null,
        queuedInBatchId: 'batch_12345678',
        shotId: 'shot_12345678',
      },
    ],
  },
  ok: true,
};

const generateInput = {
  projectId: 'project_12345678',
  requestId: 'request_generate_1',
  shotId: 'shot_12345678',
};
const selectInput = {
  candidateId: 'vcand_12345678',
  projectId: 'project_12345678',
  requestId: 'request_select_1',
};

const createHarness = (ready = true) => {
  const handlers = new Map<
    string,
    (event: ReturnType<typeof trustedEvent>, ...arguments_: readonly unknown[]) => Promise<unknown>
  >();
  const service: VideoIpcService = {
    generateVideoCandidates: vi.fn(() => Promise.resolve(okTask)),
    listVideoCandidates: vi.fn(() => Promise.resolve(okCandidates)),
    selectVideoCandidate: vi.fn(() => Promise.resolve(okCandidates)),
    getVideoTask: vi.fn(() => Promise.resolve(okTask)),
    generateVideosForShots: vi.fn(() => Promise.resolve(okBatch)),
    cancelVideoBatch: vi.fn(() => Promise.resolve(okBatch)),
    listStoryboardVideoStates: vi.fn(() => Promise.resolve(okStates)),
  };
  registerVideoIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    service,
    { isWriteReady: () => ready },
    'jingxu://app/index.html',
    { newTraceId: () => 'trace_video_12345678' },
  );
  return { handlers, service };
};

describe('Video Main IPC Contract', () => {
  it('注册边界—固定七方法—可信 sender 与 strict DTO 后委托 Application', async () => {
    const { handlers, service } = createHarness();
    expect([...handlers.keys()].sort()).toEqual(Object.values(VIDEO_IPC_CHANNELS).sort());

    await expect(
      handlers.get(VIDEO_IPC_CHANNELS.generateVideoCandidates)?.(trustedEvent(), generateInput),
    ).resolves.toEqual(okTask);
    await expect(
      handlers.get(VIDEO_IPC_CHANNELS.listVideoCandidates)?.(trustedEvent(), {
        projectId: 'project_12345678',
        shotId: 'shot_12345678',
      }),
    ).resolves.toEqual(okCandidates);
    // 批量三通道：命令走 singleflight、聚合走查询。
    await expect(
      handlers.get(VIDEO_IPC_CHANNELS.generateVideosForShots)?.(trustedEvent(), {
        projectId: 'project_12345678',
        requestId: 'request_batch_1',
        shotIds: ['shot_12345678', 'shot_87654321'],
      }),
    ).resolves.toEqual(okBatch);
    await expect(
      handlers.get(VIDEO_IPC_CHANNELS.listStoryboardVideoStates)?.(trustedEvent(), {
        projectId: 'project_12345678',
      }),
    ).resolves.toEqual(okStates);
    expect(service.generateVideoCandidates).toHaveBeenCalledWith(
      generateInput,
      'trace_video_12345678',
    );
    expect(service.generateVideosForShots).toHaveBeenCalledWith(
      {
        projectId: 'project_12345678',
        requestId: 'request_batch_1',
        shotIds: ['shot_12345678', 'shot_87654321'],
      },
      'trace_video_12345678',
    );
    expect(service.listStoryboardVideoStates).toHaveBeenCalledWith(
      { projectId: 'project_12345678' },
      'trace_video_12345678',
    );
  });

  it('非 READY—七方法（含只读查询）统一阻断—Service 零调用', async () => {
    const { handlers, service } = createHarness(false);
    const inputs: readonly [string, unknown][] = [
      [VIDEO_IPC_CHANNELS.generateVideoCandidates, generateInput],
      [VIDEO_IPC_CHANNELS.selectVideoCandidate, selectInput],
      [
        VIDEO_IPC_CHANNELS.listVideoCandidates,
        { projectId: 'project_12345678', shotId: 'shot_12345678' },
      ],
      [VIDEO_IPC_CHANNELS.getVideoTask, { projectId: 'project_12345678', taskId: 'task_12345678' }],
      [
        VIDEO_IPC_CHANNELS.generateVideosForShots,
        {
          projectId: 'project_12345678',
          requestId: 'request_batch_1',
          shotIds: ['shot_12345678', 'shot_87654321'],
        },
      ],
      [
        VIDEO_IPC_CHANNELS.cancelVideoBatch,
        { batchId: 'batch_12345678', projectId: 'project_12345678', requestId: 'request_cancel_1' },
      ],
      [VIDEO_IPC_CHANNELS.listStoryboardVideoStates, { projectId: 'project_12345678' }],
    ];
    for (const [channel, input] of inputs) {
      await expect(handlers.get(channel)?.(trustedEvent(), input)).resolves.toMatchObject({
        error: { code: 'STARTUP_WRITE_BLOCKED' },
        ok: false,
      });
    }
    expect(service.generateVideoCandidates).not.toHaveBeenCalled();
    expect(service.listVideoCandidates).not.toHaveBeenCalled();
    expect(service.getVideoTask).not.toHaveBeenCalled();
    expect(service.generateVideosForShots).not.toHaveBeenCalled();
    expect(service.cancelVideoBatch).not.toHaveBeenCalled();
    expect(service.listStoryboardVideoStates).not.toHaveBeenCalled();
  });

  it('未知字段与重复 shotIds—输入拒绝—Service 零调用', async () => {
    const { handlers, service } = createHarness();
    const handle = handlers.get(VIDEO_IPC_CHANNELS.generateVideosForShots);
    await expect(
      handle?.(trustedEvent(), {
        projectId: 'project_12345678',
        requestId: 'request_batch_1',
        shotIds: ['shot_12345678', 'shot_12345678'],
      }),
    ).resolves.toMatchObject({ error: { code: 'IPC_INVALID_REQUEST' } });
    await expect(
      handle?.(trustedEvent(), {
        fileSha256: hash64('leak'),
        projectId: 'project_12345678',
        requestId: 'request_batch_1',
        shotIds: ['shot_12345678'],
      }),
    ).resolves.toMatchObject({ error: { code: 'IPC_INVALID_REQUEST' } });
    expect(service.generateVideosForShots).not.toHaveBeenCalled();
  });

  it('不可信 frame—边界直接拒绝—Service 零调用', () => {
    const { handlers, service } = createHarness();
    const event = trustedEvent();
    expect(() =>
      handlers.get(VIDEO_IPC_CHANNELS.listVideoCandidates)?.(
        { ...event, senderFrame: { url: 'https://evil.example/' } },
        { projectId: 'project_12345678', shotId: 'shot_12345678' },
      ),
    ).toThrow('IPC_SENDER_NOT_ALLOWED');
    expect(service.listVideoCandidates).not.toHaveBeenCalled();
  });

  it('同 requestId 并发同命令—singleflight 同结果—Application 只调用一次', async () => {
    const { handlers, service } = createHarness();
    let finish: ((value: AppResultDto<MediaTaskViewDto>) => void) | undefined;
    vi.mocked(service.generateVideoCandidates).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const handle = handlers.get(VIDEO_IPC_CHANNELS.generateVideoCandidates);
    const first = handle?.(trustedEvent(), generateInput);
    const second = handle?.(trustedEvent(), generateInput);
    await vi.waitFor(() => {
      expect(service.generateVideoCandidates).toHaveBeenCalledOnce();
    });
    finish?.(okTask);
    await expect(Promise.all([first, second])).resolves.toEqual([okTask, okTask]);
    expect(service.generateVideoCandidates).toHaveBeenCalledOnce();
  });

  it('同 requestId 并发不同命令—返回 REQUEST_ID_REUSED—不执行第二次写入', async () => {
    const { handlers, service } = createHarness();
    let finish: ((value: AppResultDto<MediaTaskViewDto>) => void) | undefined;
    vi.mocked(service.generateVideoCandidates).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const first = handlers.get(VIDEO_IPC_CHANNELS.generateVideoCandidates)?.(
      trustedEvent(),
      generateInput,
    );
    await vi.waitFor(() => {
      expect(service.generateVideoCandidates).toHaveBeenCalledOnce();
    });
    await expect(
      handlers.get(VIDEO_IPC_CHANNELS.selectVideoCandidate)?.(trustedEvent(), {
        ...selectInput,
        requestId: generateInput.requestId,
      }),
    ).resolves.toMatchObject({ error: { code: 'REQUEST_ID_REUSED' }, ok: false });
    finish?.(okTask);
    await first;
    expect(service.selectVideoCandidate).not.toHaveBeenCalled();
  });

  it('Service throw 或畸形输出—统一脱敏错误—零路径、SQL、原文、Key、响应泄漏', async () => {
    const { handlers, service } = createHarness();
    vi.mocked(service.getVideoTask).mockRejectedValue(
      new Error('C:\\Users\\secret SELECT * apiKey=sk-secret raw response prompt 原文'),
    );
    const result = await handlers.get(VIDEO_IPC_CHANNELS.getVideoTask)?.(trustedEvent(), {
      projectId: 'project_12345678',
      taskId: 'task_12345678',
    });
    expect(result).toMatchObject({ error: { code: 'PROJECT_PERSISTENCE_FAILED' }, ok: false });
    const serialized = JSON.stringify(result);
    for (const secret of ['C:\\', 'SELECT', 'sk-secret', 'raw response', '原文']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('输出越权字段（候选携带绝对路径/mediaUrl 越前缀）—schema 拒绝为脱敏失败', async () => {
    const { handlers, service } = createHarness();
    vi.mocked(service.listVideoCandidates).mockResolvedValue({
      data: [
        {
          ...candidate,
          mediaUrl: 'file:///C:/Users/secret/leak.mp4',
          status: 'SUCCEEDED',
        },
      ],
      ok: true,
    });
    await expect(
      handlers.get(VIDEO_IPC_CHANNELS.listVideoCandidates)?.(trustedEvent(), {
        projectId: 'project_12345678',
        shotId: 'shot_12345678',
      }),
    ).resolves.toMatchObject({ error: { code: 'PROJECT_PERSISTENCE_FAILED' }, ok: false });
  });
});
