import { describe, expect, it } from 'vitest';

import type { MediaModelPort } from '../ports/media/media-model-port';
import type { MediaUnitOfWorkPort, VideoProviderProvenance } from '../ports/media/media-repository';
import type { NormalizedModelError } from '../ports/text-model/text-model-types';
import type {
  ScriptWorkspaceSnapshot,
  ShotContractVersion,
  StoryboardShotSnapshot,
} from '../ports/script/script-types';
import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import type {
  VideoGenerationRequest,
  VideoResultRef,
} from '../ports/video-model/video-model-types';
import { InMemoryMediaInvocationRepository } from './in-memory-media-invocation-repository';
import { InMemoryMediaRepository } from './in-memory-media-repository';
import { InMemoryVideoMediaRepository } from './in-memory-video-media-repository';
import type { MediaFileStorePort, MediaTaskScheduler } from './media-task-scheduler';
import { createMediaTaskScheduler } from './media-task-scheduler';
import { createVideoRequestBlueprintBuilder } from './video-request-blueprint';

const NOW = '2026-08-16T00:00:00.000Z';
const VIDEO_MODEL_ID = 'doubao-seedance-1-0-lite-i2v-250428';
const IMAGE_MODEL_ID = 'doubao-seedream-5-0-lite-260128';
const hash64 = (seed: string): string => `${seed}_${'.'.repeat(64)}`.slice(0, 64);
const IMG_SHA_1 = '1'.repeat(64);
/** 首帧落列口径 1440x2560 → 视频档位 1080x1920（resolveVideoSize 金样锁定）。 */
const VIDEO_SIZE = { height: 1920, width: 1080 };
const VIDEO_PROMPT = '少女撑伞走过雨巷，怅惘\n叙事目的：建立雨巷氛围\n运镜：推轨';
const FIRST_FRAME_BYTES = Uint8Array.from([1, 1, 1, 1]);
/** 拍板 D3：视频每轮候选数。 */
const VIDEO_CANDIDATE_COUNT = 2;

/** poll 脚本：窗口（首次 PENDING 次 SUCCEEDED 带 actualDurationSec）/ 恒 PENDING / 抛错。 */
type PollPlan = 'SUCCEEDED' | 'ALWAYS_PENDING' | 'ERROR' | 'FLAKY';

interface FakePortOptions {
  readonly downloadGate?: Promise<void>;
  readonly pollPlan?: PollPlan;
  readonly pollErrorCode?: NormalizedModelError['code'];
}

/** 顺序记录 submit/poll/download（Seedance 形态：恒 ASYNC）。 */
class FakeVideoModel implements MediaModelPort<VideoGenerationRequest> {
  public readonly order: string[] = [];
  private readonly pollCounts = new Map<string, number>();

  public constructor(private readonly options: FakePortOptions = {}) {}

  public submitCount(): number {
    return this.order.filter((entry) => entry.startsWith('submit:')).length;
  }

  public pollCount(): number {
    return this.order.filter((entry) => entry.startsWith('poll:')).length;
  }

  public validateCredential(): Promise<{ ok: true }> {
    return Promise.resolve({ ok: true });
  }

  public submit(
    request: VideoGenerationRequest,
  ): Promise<{ kind: 'ASYNC'; providerTaskId: string }> {
    this.order.push(`submit:${request.invocationId}`);
    return Promise.resolve({ kind: 'ASYNC', providerTaskId: `pt_${String(this.submitCount())}` });
  }

  public poll(providerTaskId: string): Promise<
    | Readonly<{ state: 'PENDING' }>
    | Readonly<{
        result: VideoResultRef;
        state: 'SUCCEEDED';
        usage: Readonly<{ generatedImages: number; outputTokens: number | null }>;
      }>
  > {
    const count = (this.pollCounts.get(providerTaskId) ?? 0) + 1;
    this.pollCounts.set(providerTaskId, count);
    this.order.push(`poll:${providerTaskId}`);
    const plan = this.options.pollPlan ?? 'SUCCEEDED';
    if (plan === 'FLAKY' && count <= 2) {
      const error = new Error('瞬时网络抖动');
      error.name = 'FlakyBoom';
      return Promise.reject(error);
    }
    if (plan === 'ALWAYS_PENDING') return Promise.resolve({ state: 'PENDING' });
    if (plan === 'ERROR') {
      const error = new Error('轮询段失败');
      error.name = 'PollBoom';
      return Promise.reject(error);
    }
    if (count === 1) return Promise.resolve({ state: 'PENDING' });
    return Promise.resolve({
      result: {
        actualDurationSec: 8,
        height: 1920,
        providerRequestId: null,
        url: `mock://${providerTaskId}`,
        width: 1080,
      },
      state: 'SUCCEEDED',
      usage: { generatedImages: 1, outputTokens: null },
    });
  }

  public async download(
    resultRef: VideoResultRef,
    _signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    if (this.options.downloadGate !== undefined) await this.options.downloadGate;
    this.order.push(`download:${resultRef.url}`);
    return { bytes: Uint8Array.from([0, 0, 0, 1]), mimeType: 'video/mp4' };
  }

  public normalizeError(caught: unknown): NormalizedModelError {
    const name = caught instanceof Error ? caught.name : '';
    if (name === 'PollBoom') {
      return {
        code: this.options.pollErrorCode ?? 'MODEL_RATE_LIMITED',
        detail: null,
        providerRequestId: null,
        retryable: false,
        userAction: null,
      };
    }
    if (name === 'FlakyBoom') {
      return {
        code: 'MODEL_NETWORK_ERROR',
        detail: null,
        providerRequestId: null,
        retryable: true,
        userAction: null,
      };
    }
    if (name === 'TimeoutError') {
      return {
        code: 'MODEL_TIMEOUT',
        detail: null,
        providerRequestId: null,
        retryable: false,
        userAction: null,
      };
    }
    if (name === 'AbortError') {
      return {
        code: 'MODEL_CANCELLED',
        detail: null,
        providerRequestId: null,
        retryable: false,
        userAction: null,
      };
    }
    return {
      code: 'MODEL_UNKNOWN',
      detail: null,
      providerRequestId: null,
      retryable: false,
      userAction: null,
    };
  }

  public evidenceOf(): null {
    return null;
  }
}

interface SchedulerFixture {
  readonly invocations: InMemoryMediaInvocationRepository;
  readonly port: FakeVideoModel;
  readonly repository: InMemoryMediaRepository;
  readonly scheduler: MediaTaskScheduler;
  readonly unitOfWork: MediaUnitOfWorkPort;
  readonly videoRepository: InMemoryVideoMediaRepository;
  readonly writes: readonly { readonly storageRelPath: string }[];
}

const buildSchedulerFixture = (
  portOptions: FakePortOptions = {},
  recordPollEvidence = true,
): SchedulerFixture => {
  const repository = new InMemoryMediaRepository();
  const videoRepository = new InMemoryVideoMediaRepository(repository.candidates);
  const invocationRepository = new InMemoryMediaInvocationRepository();
  const unitOfWork: MediaUnitOfWorkPort = {
    run: (work) =>
      work({ invocations: invocationRepository, media: repository, video: videoRepository }),
  };
  const port = new FakeVideoModel(portOptions);
  const writes: { byteSize: number; storageRelPath: string }[] = [];
  const fileStore: MediaFileStorePort = {
    writeMedia: ({ projectId }) => {
      const sha256 = hash64(`vstored_${String(writes.length + 1)}`);
      const record = {
        byteSize: 4,
        mimeType: 'video/mp4',
        projectId,
        sha256,
        storageRelPath: `projects/${projectId}/videos/${sha256.slice(0, 2)}/${sha256}.mp4`,
      };
      writes.push({ byteSize: record.byteSize, storageRelPath: record.storageRelPath });
      return Promise.resolve(record);
    },
  };
  let clock = 0;
  const scheduler = createMediaTaskScheduler({
    fileStore,
    // 任务 3.3：video 实例三注入——生成域重定向 / POLL 证据行 / 成功载荷域扩展。
    generation: (repos) => repos.video,
    hashText: hash64,
    model: port,
    mediaUnitOfWork: unitOfWork,
    newId: (() => {
      let counter = 0;
      return () => `inv_${String((counter += 1))}`;
    })(),
    nowMs: () => {
      clock += 50;
      return clock;
    },
    pollDeadlineMs: 200,
    pollIntervalMs: 0,
    recordPollEvidence,
    requestBuilder: {
      build: () =>
        Promise.resolve({
          buildRequest: (invocationId: string) => ({
            durationSec: 8,
            firstFrame: { bytes: FIRST_FRAME_BYTES, mimeType: 'image/png' },
            invocationId,
            modelId: VIDEO_MODEL_ID,
            prompt: VIDEO_PROMPT,
            resolution: VIDEO_SIZE,
          }),
          modelId: VIDEO_MODEL_ID,
          submitSnapshotJson: JSON.stringify({
            durationSec: 8,
            firstFrameCandidateId: 'img_1',
            firstFrameFileSha256: IMG_SHA_1,
            modelId: VIDEO_MODEL_ID,
            prompt: VIDEO_PROMPT,
            resolution: VIDEO_SIZE,
          }),
        }),
    },
    resultMetaOf: (result) => ({
      actualDurationSec: (result as VideoResultRef).actualDurationSec,
    }),
    segmentTimeoutMs: 5_000,
    sleep: () => Promise.resolve(undefined),
  });
  return {
    invocations: invocationRepository,
    port,
    repository,
    scheduler,
    unitOfWork,
    videoRepository,
    writes,
  };
};

/** 选中首帧（image 域 round 1 SUCCEEDED + selectedAt）。 */
const seedFirstFrame = async (
  unitOfWork: MediaUnitOfWorkPort,
  shotId: string,
  candidateId = 'img_1',
): Promise<{ candidateId: string; fileSha256: string }> => {
  const inserted = await unitOfWork.run(({ media }) =>
    media.insertCandidates({
      candidateIds: [candidateId],
      generationInputHash: hash64('igen'),
      modelId: IMAGE_MODEL_ID,
      projectId: 'project_1',
      roundNo: 1,
      shotId,
      shotVersionId: 'scv_1',
    }),
  );
  const candidate = inserted[0];
  if (candidate === undefined) throw new Error('首帧候选播种失败');
  await unitOfWork.run(({ media }) =>
    media.completeCandidateSucceeded(candidate.id, {
      byteSize: 2048,
      fileSha256: IMG_SHA_1,
      height: 2560,
      invocationEvidenceRef: 'inv_img',
      mimeType: 'image/png',
      storageRelPath: `projects/project_1/images/${IMG_SHA_1.slice(0, 2)}/${IMG_SHA_1}.png`,
      width: 1440,
    }),
  );
  await unitOfWork.run(({ media }) => media.selectCandidate(shotId, candidate.id));
  return { candidateId: candidate.id, fileSha256: IMG_SHA_1 };
};

/** 建视频任务 + 2 个 PENDING 候选（首帧锚点对 + 档位时长 8s 冻结；可带显式溯源）。 */
const seedVideoTask = async (
  unitOfWork: MediaUnitOfWorkPort,
  shotId = 'shot_1',
  taskId = 'vtask_1',
  provenance?: VideoProviderProvenance,
): Promise<string> => {
  const anchor = await seedFirstFrame(
    unitOfWork,
    shotId,
    shotId === 'shot_1' ? 'img_1' : `img_${shotId}`,
  );
  const task = await unitOfWork.run(({ video }) =>
    video.insertTask({
      batchId: null,
      candidateCount: VIDEO_CANDIDATE_COUNT,
      generationInputHash: hash64('vgen'),
      id: taskId,
      idempotencyKey: `vreq_${taskId}`,
      projectId: 'project_1',
      ...(provenance === undefined ? {} : { provenance }),
      shotId,
      shotVersionId: 'scv_1',
    }),
  );
  // 候选 id 按任务派生避免跨任务撞行；默认任务保持历史 id（既有断言零变化）。
  const candidateIds =
    taskId === 'vtask_1' ? ['vc_1', 'vc_2'] : [`${taskId}_vc_1`, `${taskId}_vc_2`];
  await unitOfWork.run(({ video }) =>
    video.insertCandidates({
      candidateIds,
      firstFrameCandidateId: anchor.candidateId,
      firstFrameFileSha256: anchor.fileSha256,
      generationInputHash: hash64('vgen'),
      modelId: provenance?.modelId ?? VIDEO_MODEL_ID,
      projectId: 'project_1',
      ...(provenance === undefined ? {} : { provenance }),
      requestedDurationSec: 8,
      roundNo: task.roundNo,
      shotId,
      shotVersionId: 'scv_1',
    }),
  );
  return task.id;
};

describe('MediaTaskScheduler 按任务冻结溯源解析（low-cost D4/任务 4.2）', () => {
  it('两个不同 Provider 冻结任务（Seedance/Agnes）—各路由到对应 Adapter—回退口零调用', async () => {
    const repository = new InMemoryMediaRepository();
    const videoRepository = new InMemoryVideoMediaRepository(repository.candidates);
    const invocationRepository = new InMemoryMediaInvocationRepository();
    const unitOfWork: MediaUnitOfWorkPort = {
      run: (work) =>
        work({ invocations: invocationRepository, media: repository, video: videoRepository }),
    };
    const seedancePort = new FakeVideoModel({ pollPlan: 'SUCCEEDED' });
    const agnesPort = new FakeVideoModel({ pollPlan: 'SUCCEEDED' });
    const fallbackPort = new FakeVideoModel({ pollPlan: 'SUCCEEDED' });
    const writes: { byteSize: number; storageRelPath: string }[] = [];
    const fileStore: MediaFileStorePort = {
      writeMedia: ({ projectId }) => {
        const sha256 = hash64(`route_${String(writes.length + 1)}`);
        const record = {
          byteSize: 4,
          mimeType: 'video/mp4',
          projectId,
          sha256,
          storageRelPath: `projects/${projectId}/videos/${sha256.slice(0, 2)}/${sha256}.mp4`,
        };
        writes.push(record);
        return Promise.resolve(record);
      },
    };
    let clock = 0;
    const scheduler = createMediaTaskScheduler({
      fileStore,
      generation: (repos) => repos.video,
      hashText: hash64,
      // 回退口 = 当前模式首配（无溯源行才用；本用例两行均有溯源 → 零调用）。
      model: fallbackPort,
      resolveModel: (task) =>
        task.provenance?.providerKind === 'AGNES_VIDEO' ? agnesPort : seedancePort,
      mediaUnitOfWork: unitOfWork,
      newId: (() => {
        let counter = 0;
        return () => `inv_${String((counter += 1))}`;
      })(),
      nowMs: () => {
        clock += 50;
        return clock;
      },
      pollDeadlineMs: 200,
      pollIntervalMs: 0,
      requestBuilder: {
        build: () =>
          Promise.resolve({
            buildRequest: (invocationId: string) => ({
              durationSec: 8,
              firstFrame: { bytes: FIRST_FRAME_BYTES, mimeType: 'image/png' },
              invocationId,
              modelId: VIDEO_MODEL_ID,
              prompt: VIDEO_PROMPT,
              resolution: VIDEO_SIZE,
            }),
            modelId: VIDEO_MODEL_ID,
            submitSnapshotJson: '{}',
          }),
      },
      resultMetaOf: (result) => ({
        actualDurationSec: (result as VideoResultRef).actualDurationSec,
      }),
      segmentTimeoutMs: 5_000,
      sleep: () => Promise.resolve(undefined),
    });
    const agnesProvenance: VideoProviderProvenance = {
      capabilitySnapshotId: 'agnes-video/v1',
      isMock: false,
      modelId: 'agnes-video-v2.0',
      providerKind: 'AGNES_VIDEO',
      providerProfileId: 'profile-video-agnes-primary',
    };
    await seedVideoTask(unitOfWork, 'shot_1', 'vtask_seed', {
      capabilitySnapshotId: 'volcark-seedance-video/v3',
      isMock: false,
      modelId: 'doubao-seedance-2-0-260128',
      providerKind: 'VOLCARK_SEEDANCE',
      providerProfileId: 'profile-video-primary',
    });
    await seedVideoTask(unitOfWork, 'shot_2', 'vtask_agnes', agnesProvenance);

    await scheduler.run('project_1');

    // 每任务 2 候选：各自 Adapter 收到 2 次 submit/download 与 2×（PENDING+SUCCEEDED）
    // 轮询（FakeVideoModel 窗口计划）；回退口零调用。
    expect(seedancePort.submitCount()).toBe(2);
    expect(agnesPort.submitCount()).toBe(2);
    expect(seedancePort.pollCount()).toBe(4);
    expect(agnesPort.pollCount()).toBe(4);
    expect(fallbackPort.submitCount()).toBe(0);
    expect(writes).toHaveLength(4);
    for (const taskId of ['vtask_seed', 'vtask_agnes']) {
      expect(videoRepository.tasks.find((task) => task.id === taskId)).toMatchObject({
        errorCode: null,
        phase: 'COMPLETED',
      });
    }
    // 偏好切换不改写冻结行：驱动后两行溯源仍为建档值。
    expect(videoRepository.tasks.find((task) => task.id === 'vtask_agnes')?.provenance).toEqual(
      agnesProvenance,
    );
  });
});

describe('MediaTaskScheduler video 实例（任务 3.3）', () => {
  it('异步全链路—轮询窗口 PENDING→SUCCEEDED—actualDurationSec 入列—POLL 行数=轮询次数实录', async () => {
    const fixture = buildSchedulerFixture();
    const taskId = await seedVideoTask(fixture.unitOfWork);
    await fixture.scheduler.run('project_1');
    expect(fixture.videoRepository.tasks.find((task) => task.id === taskId)).toMatchObject({
      errorCode: null,
      phase: 'COMPLETED',
      providerTaskId: 'pt_1',
    });
    // 先留证后轮询（spec 不变式沿用）。
    const firstPoll = fixture.port.order.findIndex((entry) => entry.startsWith('poll:'));
    const lastSubmit = fixture.port.order
      .map((entry) => entry.startsWith('submit:'))
      .lastIndexOf(true);
    expect(firstPoll).toBeGreaterThan(lastSubmit);
    // resultMetaOf 通道：Provider 回报实际时长随成功载荷落列；文件四元组 mp4/videos 命名空间。
    for (const candidate of fixture.videoRepository.candidates) {
      expect(candidate).toMatchObject({
        actualDurationSec: 8,
        errorCode: null,
        height: 1920,
        mimeType: 'video/mp4',
        status: 'SUCCEEDED',
        width: 1080,
      });
      expect(candidate.storageRelPath).toContain('/videos/');
    }
    expect(fixture.writes).toHaveLength(2);
    const rows = fixture.invocations.invocations;
    const submitRows = rows.filter((row) => row.segmentKind === 'SUBMIT');
    const pollRows = rows.filter((row) => row.segmentKind === 'POLL');
    const downloadRows = rows.filter((row) => row.segmentKind === 'DOWNLOAD');
    // 三段齐：2 SUBMIT + 4 POLL（每候选先 PENDING 后 SUCCEEDED 两次轮询）+ 2 DOWNLOAD。
    expect(submitRows).toHaveLength(2);
    expect(pollRows).toHaveLength(4);
    expect(downloadRows).toHaveLength(2);
    // design A6：POLL 行数=轮询次数实录；逐行快照只含 providerTaskId。
    expect(pollRows.length).toBe(fixture.port.pollCount());
    const pollSnapshots = pollRows.map((row) => row.requestSnapshotJson);
    expect(pollSnapshots.slice(0, 2)).toEqual([
      JSON.stringify({ providerTaskId: 'pt_1' }),
      JSON.stringify({ providerTaskId: 'pt_1' }),
    ]);
    expect(pollRows.every((row) => row.status === 'SUCCEEDED' && row.finishedAt !== null)).toBe(
      true,
    );
    // SUBMIT 行按 SUCCEEDED 收尾：ASYNC 轮询成功路径 raw 为 null、usage/generatedImages 落列。
    for (const [index, row] of submitRows.entries()) {
      const providerTaskId = `pt_${String(index + 1)}`;
      expect(row.id).toBe(`inv_${String(index + 1)}`);
      expect(row).toMatchObject({
        providerRequestId: providerTaskId,
        providerReportedGeneratedImages: 1,
        rawResponseBlob: null,
        status: 'SUCCEEDED',
      });
      expect(JSON.parse(row.requestSnapshotJson)).toEqual({
        durationSec: 8,
        firstFrameCandidateId: 'img_1',
        firstFrameFileSha256: IMG_SHA_1,
        modelId: VIDEO_MODEL_ID,
        prompt: VIDEO_PROMPT,
        resolution: { height: 1920, width: 1080 },
      });
    }
    // DOWNLOAD 轻量行：blob 恒 NULL（mp4 字节只在内容寻址存储）、sha256=落盘哈希。
    for (const [index, row] of downloadRows.entries()) {
      expect(JSON.parse(row.requestSnapshotJson)).toEqual({
        providerRequestId: null,
        resultUrl: `mock://pt_${String(index + 1)}`,
      });
      expect(row).toMatchObject({ rawResponseBlob: null, status: 'SUCCEEDED' });
      expect(row.rawResponseSha256).toBe(hash64(`vstored_${String(index + 1)}`));
    }
    // 候选 ref 恒指 SUBMIT 证据行（非 providerTaskId）。
    expect(
      fixture.videoRepository.candidates.map((candidate) => candidate.invocationEvidenceRef),
    ).toEqual(['inv_1', 'inv_2']);
  });

  it('轮询截止—恒 PENDING 到 deadline—候选 MODEL_TIMEOUT—POLL 行如实逐次留痕', async () => {
    const fixture = buildSchedulerFixture({ pollPlan: 'ALWAYS_PENDING' });
    await seedVideoTask(fixture.unitOfWork);
    await fixture.scheduler.run('project_1');
    expect(fixture.videoRepository.tasks[0]).toMatchObject({ phase: 'COMPLETED' });
    expect(fixture.videoRepository.candidates.map((candidate) => candidate.status)).toEqual([
      'FAILED',
      'FAILED',
    ]);
    expect(fixture.videoRepository.candidates[0]).toMatchObject({ errorCode: 'MODEL_TIMEOUT' });
    const pollRows = fixture.invocations.invocations.filter((row) => row.segmentKind === 'POLL');
    expect(pollRows.length).toBe(fixture.port.pollCount());
    expect(pollRows.every((row) => row.status === 'SUCCEEDED')).toBe(true);
  });

  it('poll 段抛错—POLL 证据行经 segmentRowId 通道同批 FAILED—候选级失败兄弟继续', async () => {
    const fixture = buildSchedulerFixture({
      pollPlan: 'ERROR',
      pollErrorCode: 'MODEL_RATE_LIMITED',
    });
    await seedVideoTask(fixture.unitOfWork);
    await fixture.scheduler.run('project_1');
    expect(fixture.videoRepository.tasks[0]).toMatchObject({ phase: 'COMPLETED' });
    expect(fixture.videoRepository.candidates.map((candidate) => candidate.status)).toEqual([
      'FAILED',
      'FAILED',
    ]);
    const rows = fixture.invocations.invocations;
    // SUBMIT 行停留 STARTED（与图片口径一致：submit 行只在下载收尾路径关闭）。
    expect(rows.filter((row) => row.segmentKind === 'SUBMIT').map((row) => row.status)).toEqual([
      'STARTED',
      'STARTED',
    ]);
    for (const row of rows.filter((row) => row.segmentKind === 'POLL')) {
      expect(row).toMatchObject({ errorCode: 'MODEL_RATE_LIMITED', status: 'FAILED' });
    }
    expect(fixture.port.submitCount()).toBe(2);
  });

  it('low-cost D5b—轮询瞬时网络错误有限容忍—两次抖动后恢复—候选不判死且抖动轮如实 FAILED', async () => {
    const fixture = buildSchedulerFixture({ pollPlan: 'FLAKY' });
    await seedVideoTask(fixture.unitOfWork);
    await fixture.scheduler.run('project_1');
    expect(fixture.videoRepository.tasks[0]).toMatchObject({
      errorCode: null,
      phase: 'COMPLETED',
    });
    expect(fixture.videoRepository.candidates.map((candidate) => candidate.status)).toEqual([
      'SUCCEEDED',
      'SUCCEEDED',
    ]);
    // 抖动轮：POLL 证据行如实 FAILED（MODEL_NETWORK_ERROR）；任务结局不受影响。
    const pollRows = fixture.invocations.invocations.filter((row) => row.segmentKind === 'POLL');
    const flakyRows = pollRows.filter((row) => row.errorCode === 'MODEL_NETWORK_ERROR');
    expect(flakyRows.length).toBeGreaterThanOrEqual(2);
    expect(flakyRows.every((row) => row.status === 'FAILED')).toBe(true);
  });

  it('取消—先落 CANCELLED 再中止—迟到下载不落库—在飞三段行如实保留', async () => {
    let releaseDownload: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const fixture = buildSchedulerFixture({ downloadGate: gate });
    const taskId = await seedVideoTask(fixture.unitOfWork);
    const driven = fixture.scheduler.run('project_1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelled = await fixture.scheduler.cancel('project_1', taskId);
    expect(cancelled).toMatchObject({ phase: 'CANCELLED' });
    releaseDownload();
    await driven;
    expect(fixture.port.submitCount()).toBe(2);
    expect(fixture.writes).toHaveLength(1); // 孤儿文件可接受（空间治理独立 change）
    expect(fixture.videoRepository.candidates.map((candidate) => candidate.status)).toEqual([
      'PENDING',
      'PENDING',
    ]);
    expect(fixture.videoRepository.tasks[0]).toMatchObject({ phase: 'CANCELLED' });
    const rows = fixture.invocations.invocations;
    expect(rows.map((row) => [row.segmentKind, row.status])).toEqual([
      ['SUBMIT', 'STARTED'],
      ['SUBMIT', 'STARTED'],
      ['POLL', 'SUCCEEDED'],
      ['POLL', 'SUCCEEDED'],
      ['DOWNLOAD', 'STARTED'],
    ]);
  });

  it('恢复—POLLING 全留证—续轮询零重发—完成全轮含 actualDurationSec', async () => {
    const fixture = buildSchedulerFixture();
    const taskId = await seedVideoTask(fixture.unitOfWork);
    await fixture.unitOfWork.run(({ video }) => video.assignCandidateProviderTask('vc_1', 'pt_1'));
    await fixture.unitOfWork.run(({ video }) => video.assignCandidateProviderTask('vc_2', 'pt_2'));
    await fixture.unitOfWork.run(({ video }) => video.markTaskPolling(taskId, 'pt_1'));
    const outcomes = await fixture.scheduler.recover('project_1');
    expect(outcomes).toEqual([{ action: 'RESUMED_POLLING', taskId }]);
    await fixture.scheduler.run('project_1');
    expect(fixture.port.submitCount()).toBe(0);
    expect(fixture.port.pollCount()).toBeGreaterThanOrEqual(2);
    expect(fixture.videoRepository.candidates.map((candidate) => candidate.status)).toEqual([
      'SUCCEEDED',
      'SUCCEEDED',
    ]);
    expect(
      fixture.videoRepository.candidates.every((candidate) => candidate.actualDurationSec === 8),
    ).toBe(true);
    expect(fixture.videoRepository.tasks.find((task) => task.id === taskId)).toMatchObject({
      phase: 'COMPLETED',
    });
  });

  it('recordPollEvidence 缺省关闭—ASYNC 全链路无 POLL 行（图片实例证据面零变化）', async () => {
    const fixture = buildSchedulerFixture({}, false);
    await seedVideoTask(fixture.unitOfWork);
    await fixture.scheduler.run('project_1');
    expect(fixture.videoRepository.candidates.map((candidate) => candidate.status)).toEqual([
      'SUCCEEDED',
      'SUCCEEDED',
    ]);
    const rows = fixture.invocations.invocations;
    expect(rows.filter((row) => row.segmentKind === 'POLL')).toHaveLength(0);
    expect(rows.filter((row) => row.segmentKind === 'SUBMIT')).toHaveLength(2);
    expect(rows.filter((row) => row.segmentKind === 'DOWNLOAD')).toHaveLength(2);
  });
});

const shotVersionOf = (
  versionId: string,
  document = JSON.stringify({
    cinematography: { camera_angle: 'EYE_LEVEL', camera_motion: 'DOLLY', shot_size: 'MEDIUM' },
    content: { action: '少女撑伞走过雨巷', character_ids: [], emotion: '怅惘', scene_id: null },
    continuity: { continuity_mode: 'SCENE_CHANGE' },
    narrative_purpose: '建立雨巷氛围',
  }),
): ShotContractVersion => ({
  createdAt: NOW,
  dialogueRenderMode: 'NARRATION_FIRST',
  document,
  documentSha256: hash64(`doc_${versionId}`),
  externalParentVersionId: null,
  formatProfileId: 'fp_1',
  id: versionId,
  lineageResolutionStatus: 'LOCAL_VERIFIED',
  parentId: null,
  sequence: 1,
  shotId: 'shot_1',
  sourceInvocationId: null,
  targetDurationSec: 8,
  versionNo: 1,
  versionStatus: 'READY',
});

const workspaceOf = (shot: StoryboardShotSnapshot): ScriptWorkspaceSnapshot => ({
  episode: null,
  projectId: 'project_1',
  sourceInput: null,
  stages: [],
  storyboard: {
    current: {
      createdAt: NOW,
      episodeId: 'episode_1',
      formatProfileId: 'fp_1',
      id: 'ev_1',
      parentId: null,
      shotSetHash: hash64('set'),
      status: 'READY',
      storyBibleVersionId: 'sbv_1',
      targetDurationSec: 90,
      versionNo: 1,
    },
    currentShots: [shot],
    history: [],
    historyTruncated: false,
  },
});

interface BlueprintFixture {
  readonly builder: ReturnType<typeof createVideoRequestBlueprintBuilder>;
  readonly readCalls: { fileSha256: string; mimeType: string; projectId: string }[];
  readonly unitOfWork: MediaUnitOfWorkPort;
  readonly videoRepository: InMemoryVideoMediaRepository;
  readonly workspaceQuery: ScriptWorkspaceQueryPort & { snapshot: ScriptWorkspaceSnapshot | null };
}

const buildBlueprintFixture = (
  shot: StoryboardShotSnapshot | null,
  capabilityOf?: Parameters<typeof createVideoRequestBlueprintBuilder>[0]['capabilityOf'],
): BlueprintFixture => {
  const repository = new InMemoryMediaRepository();
  const videoRepository = new InMemoryVideoMediaRepository(repository.candidates);
  const unitOfWork: MediaUnitOfWorkPort = {
    run: (work) =>
      work({
        invocations: new InMemoryMediaInvocationRepository(),
        media: repository,
        video: videoRepository,
      }),
  };
  const workspaceQuery: ScriptWorkspaceQueryPort & {
    snapshot: ScriptWorkspaceSnapshot | null;
  } = {
    snapshot: shot === null ? null : workspaceOf(shot),
    getWorkspace: () => Promise.resolve(workspaceQuery.snapshot),
    getVersionDocument: () => Promise.resolve(null),
  };
  const readCalls: { fileSha256: string; mimeType: string; projectId: string }[] = [];
  return {
    builder: createVideoRequestBlueprintBuilder({
      ...(capabilityOf === undefined ? {} : { capabilityOf }),
      firstFrameReader: {
        readReference: (input) => {
          readCalls.push(input);
          return Promise.resolve(FIRST_FRAME_BYTES);
        },
      },
      mediaUnitOfWork: unitOfWork,
      workspaceQuery,
    }),
    readCalls,
    unitOfWork,
    videoRepository,
    workspaceQuery,
  };
};

describe('createVideoRequestBlueprintBuilder（任务 3.3）', () => {
  it('冻结锚点重建请求—首帧字节同通道读取—快照字段序冻结不含字节', async () => {
    const fixture = buildBlueprintFixture({
      sequence: 1,
      shotId: 'shot_1',
      version: shotVersionOf('scv_1'),
    });
    const anchor = await seedFirstFrame(fixture.unitOfWork, 'shot_1');
    const task = await fixture.unitOfWork.run(({ video }) =>
      video.insertTask({
        batchId: null,
        candidateCount: VIDEO_CANDIDATE_COUNT,
        generationInputHash: hash64('vgen'),
        id: 'vtask_1',
        idempotencyKey: 'vreq_1',
        projectId: 'project_1',
        shotId: 'shot_1',
        shotVersionId: 'scv_1',
      }),
    );
    await fixture.unitOfWork.run(({ video }) =>
      video.insertCandidates({
        candidateIds: ['vc_1', 'vc_2'],
        firstFrameCandidateId: anchor.candidateId,
        firstFrameFileSha256: anchor.fileSha256,
        generationInputHash: hash64('vgen'),
        modelId: VIDEO_MODEL_ID,
        projectId: 'project_1',
        requestedDurationSec: 8,
        roundNo: task.roundNo,
        shotId: 'shot_1',
        shotVersionId: 'scv_1',
      }),
    );
    const blueprint = await fixture.builder.build(task);
    expect(blueprint.modelId).toBe(VIDEO_MODEL_ID);
    expect(blueprint.buildRequest('inv_9')).toEqual({
      durationSec: 8,
      firstFrame: { bytes: FIRST_FRAME_BYTES, mimeType: 'image/png' },
      invocationId: 'inv_9',
      modelId: VIDEO_MODEL_ID,
      prompt: VIDEO_PROMPT,
      resolution: VIDEO_SIZE,
    });
    // 快照冻结字段序（requestSha256 稳定性）：溯源标识（low-cost D4，任务行缺省
    // Seedance 档）+ 时长/首帧锚点对/模型/提示词/分辨率；不含首帧字节与凭据。
    expect(blueprint.submitSnapshotJson).toBe(
      `{"capabilitySnapshotId":"volcark-seedance-video/v3","isMock":false,"providerKind":"VOLCARK_SEEDANCE","providerProfileId":"profile-video-primary","durationSec":8,"firstFrameCandidateId":"img_1","firstFrameFileSha256":"${IMG_SHA_1}","modelId":"${VIDEO_MODEL_ID}","prompt":"少女撑伞走过雨巷，怅惘\\n叙事目的：建立雨巷氛围\\n运镜：推轨","resolution":{"height":1920,"width":1080}}`,
    );
    expect(fixture.readCalls).toEqual([
      { fileSha256: IMG_SHA_1, mimeType: 'image/png', projectId: 'project_1' },
    ]);
  });

  it('low-cost 4.3—Agnes 冻结溯源—蓝图分辨率按 [720] 档重建（不产生 1080）', async () => {
    const agnesCapability = {
      durationRange: { maxSec: 5, minSec: 5 },
      resolutionTiers: [720],
    } as const;
    const fixture = buildBlueprintFixture(
      { sequence: 1, shotId: 'shot_1', version: shotVersionOf('scv_1') },
      () => agnesCapability,
    );
    const anchor = await seedFirstFrame(fixture.unitOfWork, 'shot_1');
    const agnesProvenance = {
      capabilitySnapshotId: 'agnes-video/v1',
      isMock: false,
      modelId: 'agnes-video-v2.0',
      providerKind: 'AGNES_VIDEO',
      providerProfileId: 'profile-video-agnes-primary',
    } as const;
    const task = await fixture.unitOfWork.run(({ video }) =>
      video.insertTask({
        batchId: null,
        candidateCount: VIDEO_CANDIDATE_COUNT,
        generationInputHash: hash64('vgen_agnes'),
        id: 'vtask_agnes',
        idempotencyKey: 'vreq_agnes',
        projectId: 'project_1',
        provenance: agnesProvenance,
        shotId: 'shot_1',
        shotVersionId: 'scv_1',
      }),
    );
    await fixture.unitOfWork.run(({ video }) =>
      video.insertCandidates({
        candidateIds: ['vc_agnes_1', 'vc_agnes_2'],
        firstFrameCandidateId: anchor.candidateId,
        firstFrameFileSha256: anchor.fileSha256,
        generationInputHash: hash64('vgen_agnes'),
        modelId: 'agnes-video-v2.0',
        projectId: 'project_1',
        provenance: agnesProvenance,
        requestedDurationSec: 5,
        roundNo: task.roundNo,
        shotId: 'shot_1',
        shotVersionId: 'scv_1',
      }),
    );
    const blueprint = await fixture.builder.build(task);
    // 1440x2560 首帧在 Agnes 固定 [720] 档下重建为 720x1280（与建档同源）。
    expect(blueprint.buildRequest('inv_agnes')).toMatchObject({
      durationSec: 5,
      resolution: { height: 1280, width: 720 },
    });
  });

  it('输入不完整—稳定 MEDIA_BLUEPRINT_* 标记交调度器归一', async () => {
    const goodShot: StoryboardShotSnapshot = {
      sequence: 1,
      shotId: 'shot_1',
      version: shotVersionOf('scv_1'),
    };
    const brokenDocShot: StoryboardShotSnapshot = {
      sequence: 1,
      shotId: 'shot_1',
      version: shotVersionOf('scv_1', '{bad json'),
    };

    // 工作区缺失。
    const missing = buildBlueprintFixture(null);
    const missingTask = await missing.unitOfWork.run(({ video }) =>
      video.insertTask({
        batchId: null,
        candidateCount: VIDEO_CANDIDATE_COUNT,
        generationInputHash: hash64('vgen'),
        id: 'vt_missing',
        idempotencyKey: 'req_missing',
        projectId: 'project_1',
        shotId: 'shot_1',
        shotVersionId: 'scv_1',
      }),
    );
    await expect(missing.builder.build(missingTask)).rejects.toThrow(
      'MEDIA_BLUEPRINT_WORKSPACE_MISSING',
    );

    // 镜头版本不一致（分镜已前进）。
    const mismatch = buildBlueprintFixture(goodShot);
    await seedFirstFrame(mismatch.unitOfWork, 'shot_1');
    const mismatchTask = await mismatch.unitOfWork.run(({ video }) =>
      video.insertTask({
        batchId: null,
        candidateCount: VIDEO_CANDIDATE_COUNT,
        generationInputHash: hash64('vgen'),
        id: 'vt_mismatch',
        idempotencyKey: 'req_mismatch',
        projectId: 'project_1',
        shotId: 'shot_1',
        shotVersionId: 'scv_other',
      }),
    );
    await expect(mismatch.builder.build(mismatchTask)).rejects.toThrow(
      'MEDIA_BLUEPRINT_SHOT_VERSION_MISMATCH',
    );

    // 任务轮无候选行（候选缺失）。
    const noCandidates = buildBlueprintFixture(goodShot);
    const bareTask = await noCandidates.unitOfWork.run(({ video }) =>
      video.insertTask({
        batchId: null,
        candidateCount: VIDEO_CANDIDATE_COUNT,
        generationInputHash: hash64('vgen'),
        id: 'vt_bare',
        idempotencyKey: 'req_bare',
        projectId: 'project_1',
        shotId: 'shot_1',
        shotVersionId: 'scv_1',
      }),
    );
    await expect(noCandidates.builder.build(bareTask)).rejects.toThrow(
      'MEDIA_BLUEPRINT_CANDIDATES_MISSING',
    );

    // 首帧锚点失效（firstFrameCandidateId 指向不存在的首帧行）。
    const ghostFrame = buildBlueprintFixture(goodShot);
    const ghostTask = await ghostFrame.unitOfWork.run(({ video }) =>
      video.insertTask({
        batchId: null,
        candidateCount: VIDEO_CANDIDATE_COUNT,
        generationInputHash: hash64('vgen'),
        id: 'vt_ghost',
        idempotencyKey: 'req_ghost',
        projectId: 'project_1',
        shotId: 'shot_1',
        shotVersionId: 'scv_1',
      }),
    );
    await ghostFrame.unitOfWork.run(({ video }) =>
      video.insertCandidates({
        candidateIds: ['vc_1'],
        firstFrameCandidateId: 'img_ghost',
        firstFrameFileSha256: IMG_SHA_1,
        generationInputHash: hash64('vgen'),
        modelId: VIDEO_MODEL_ID,
        projectId: 'project_1',
        requestedDurationSec: 8,
        roundNo: ghostTask.roundNo,
        shotId: 'shot_1',
        shotVersionId: 'scv_1',
      }),
    );
    await expect(ghostFrame.builder.build(ghostTask)).rejects.toThrow(
      'MEDIA_BLUEPRINT_FIRST_FRAME_INVALID',
    );

    // 镜头文档损坏（视频字段提取 null）。
    const broken = buildBlueprintFixture(brokenDocShot);
    await seedFirstFrame(broken.unitOfWork, 'shot_1');
    const brokenTask = await broken.unitOfWork.run(({ video }) =>
      video.insertTask({
        batchId: null,
        candidateCount: VIDEO_CANDIDATE_COUNT,
        generationInputHash: hash64('vgen'),
        id: 'vt_broken',
        idempotencyKey: 'req_broken',
        projectId: 'project_1',
        shotId: 'shot_1',
        shotVersionId: 'scv_1',
      }),
    );
    await broken.unitOfWork.run(({ video }) =>
      video.insertCandidates({
        candidateIds: ['vc_1'],
        firstFrameCandidateId: 'img_1',
        firstFrameFileSha256: IMG_SHA_1,
        generationInputHash: hash64('vgen'),
        modelId: VIDEO_MODEL_ID,
        projectId: 'project_1',
        requestedDurationSec: 8,
        roundNo: brokenTask.roundNo,
        shotId: 'shot_1',
        shotVersionId: 'scv_1',
      }),
    );
    await expect(broken.builder.build(brokenTask)).rejects.toThrow('MEDIA_BLUEPRINT_SHOT_INVALID');
  });
});

describe('MediaTaskScheduler 重启/切换串线（low-cost D4/任务 4.4）', () => {
  const PROVENANCE_BY_KIND = {
    AGNES: {
      capabilitySnapshotId: 'agnes-video/v1',
      isMock: false,
      modelId: 'agnes-video-v2.0',
      providerKind: 'AGNES_VIDEO',
      providerProfileId: 'profile-video-agnes-primary',
    },
    MOCK: {
      capabilitySnapshotId: 'volcark-seedance-video/v3',
      isMock: true,
      modelId: 'doubao-seedance-2-0-260128',
      providerKind: 'VOLCARK_SEEDANCE',
      providerProfileId: 'profile-video-primary',
    },
    SEEDANCE: {
      capabilitySnapshotId: 'volcark-seedance-video/v3',
      isMock: false,
      modelId: 'doubao-seedance-2-0-260128',
      providerKind: 'VOLCARK_SEEDANCE',
      providerProfileId: 'profile-video-primary',
    },
  } as const;

  interface RoutingFixture {
    readonly fallbackPort: FakeVideoModel;
    readonly ports: Readonly<Record<'agnes' | 'mock' | 'seedance', FakeVideoModel>>;
    readonly scheduler: MediaTaskScheduler;
    readonly unitOfWork: MediaUnitOfWorkPort;
    readonly videoRepository: InMemoryVideoMediaRepository;
  }

  const buildRoutingFixture = (pollErrorCode?: NormalizedModelError['code']): RoutingFixture => {
    const repository = new InMemoryMediaRepository();
    const videoRepository = new InMemoryVideoMediaRepository(repository.candidates);
    const invocationRepository = new InMemoryMediaInvocationRepository();
    const unitOfWork: MediaUnitOfWorkPort = {
      run: (work) =>
        work({ invocations: invocationRepository, media: repository, video: videoRepository }),
    };
    const ports = {
      agnes: new FakeVideoModel(
        pollErrorCode === undefined ? {} : { pollErrorCode, pollPlan: 'ERROR' as PollPlan },
      ),
      mock: new FakeVideoModel({}),
      seedance: new FakeVideoModel({}),
    };
    // 「当前模式已切换」以回退口为代表（重启后组合根按新模式首配）；按任务冻结
    // 溯源路由的 resolveModel 不看当前模式——Mock 标记优先于 Provider 枚举。
    const fallbackPort = new FakeVideoModel({});
    let clock = 0;
    const writes: { byteSize: number; storageRelPath: string }[] = [];
    const scheduler = createMediaTaskScheduler({
      fileStore: {
        writeMedia: ({ projectId }) => {
          const sha256 = hash64(`restart_${String(writes.length + 1)}`);
          const record = {
            byteSize: 4,
            mimeType: 'video/mp4',
            projectId,
            sha256,
            storageRelPath: `projects/${projectId}/videos/${sha256.slice(0, 2)}/${sha256}.mp4`,
          };
          writes.push(record);
          return Promise.resolve(record);
        },
      },
      generation: (repos) => repos.video,
      hashText: hash64,
      model: fallbackPort,
      resolveModel: (task) => {
        const provenance = task.provenance;
        if (provenance === undefined) return null;
        if (provenance.isMock) return ports.mock;
        if (provenance.providerKind === 'AGNES_VIDEO') return ports.agnes;
        return ports.seedance;
      },
      mediaUnitOfWork: unitOfWork,
      newId: (() => {
        let counter = 0;
        return () => `inv_${String((counter += 1))}`;
      })(),
      nowMs: () => {
        clock += 50;
        return clock;
      },
      pollDeadlineMs: 200,
      pollIntervalMs: 0,
      requestBuilder: {
        build: () =>
          Promise.resolve({
            buildRequest: (invocationId: string) => ({
              durationSec: 5,
              firstFrame: { bytes: FIRST_FRAME_BYTES, mimeType: 'image/png' },
              invocationId,
              modelId: 'restart-model',
              prompt: VIDEO_PROMPT,
              resolution: VIDEO_SIZE,
            }),
            modelId: 'restart-model',
            submitSnapshotJson: '{}',
          }),
      },
      resultMetaOf: (result) => ({
        actualDurationSec: (result as VideoResultRef).actualDurationSec,
      }),
      segmentTimeoutMs: 5_000,
      sleep: () => Promise.resolve(undefined),
    });
    return { fallbackPort, ports, scheduler, unitOfWork, videoRepository };
  };

  /** 建一枚「已提交、已留证、POLLING 中」的在途任务（重启前的崩溃窗口后形态）。 */
  const seedInFlightTask = async (
    unitOfWork: MediaUnitOfWorkPort,
    shotId: string,
    taskId: string,
    provenance: (typeof PROVENANCE_BY_KIND)[keyof typeof PROVENANCE_BY_KIND],
  ): Promise<string> => {
    const id = await seedVideoTask(unitOfWork, shotId, taskId, provenance);
    await unitOfWork.run(({ video }) =>
      video.assignCandidateProviderTask(`${taskId}_vc_1`, 'pt_1'),
    );
    await unitOfWork.run(({ video }) =>
      video.assignCandidateProviderTask(`${taskId}_vc_2`, 'pt_2'),
    );
    await unitOfWork.run(({ video }) => video.markTaskPolling(id, 'pt_1'));
    return id;
  };

  it('四类在途任务—当前模式改变后重启恢复—各由原 Adapter 续轮询/下载且全程零重发', async () => {
    const fixture = buildRoutingFixture();
    const tasks = [
      {
        port: fixture.ports.seedance,
        provenance: PROVENANCE_BY_KIND.SEEDANCE,
        shot: 'shot_s',
        taskId: 'vtask_seed',
      },
      {
        port: fixture.ports.agnes,
        provenance: PROVENANCE_BY_KIND.AGNES,
        shot: 'shot_a',
        taskId: 'vtask_agn',
      },
      {
        port: fixture.ports.mock,
        provenance: PROVENANCE_BY_KIND.MOCK,
        shot: 'shot_m',
        taskId: 'vtask_mock',
      },
    ] as const;
    for (const entry of tasks) {
      await seedInFlightTask(fixture.unitOfWork, entry.shot, entry.taskId, entry.provenance);
    }

    const outcomes = await fixture.scheduler.recover('project_1');
    expect(outcomes.filter((outcome) => outcome.action === 'RESUMED_POLLING')).toHaveLength(3);
    await fixture.scheduler.run('project_1');

    // 各原 Adapter 收到本任务的轮询与下载；当前模式回退口零调用；全程零新 submit。
    for (const entry of tasks) {
      expect(entry.port.submitCount(), `${entry.taskId} 零重发`).toBe(0);
      expect(entry.port.pollCount(), `${entry.taskId} 续轮询`).toBeGreaterThanOrEqual(2);
      expect(
        entry.port.order.filter((line) => line.startsWith('download:')).length,
        `${entry.taskId} 原 Adapter 下载`,
      ).toBe(2);
      expect(fixture.videoRepository.tasks.find((task) => task.id === entry.taskId)).toMatchObject({
        errorCode: null,
        phase: 'COMPLETED',
      });
      // 冻结溯源在驱动后不改写。
      expect(
        fixture.videoRepository.tasks.find((task) => task.id === entry.taskId)?.provenance,
      ).toEqual(entry.provenance);
    }
    expect(fixture.fallbackPort.submitCount()).toBe(0);
    expect(fixture.fallbackPort.pollCount()).toBe(0);
  });

  it('Agnes 轮询结果 UNKNOWN—归一 MODEL_RESULT_UNAVAILABLE—候选失败零重发、兄弟任务不受影响', async () => {
    const fixture = buildRoutingFixture('MODEL_RESULT_UNAVAILABLE');
    await seedInFlightTask(fixture.unitOfWork, 'shot_a', 'vtask_agn', PROVENANCE_BY_KIND.AGNES);
    await seedInFlightTask(fixture.unitOfWork, 'shot_s', 'vtask_seed', PROVENANCE_BY_KIND.SEEDANCE);

    const outcomes = await fixture.scheduler.recover('project_1');
    expect(outcomes.filter((outcome) => outcome.action === 'RESUMED_POLLING')).toHaveLength(2);
    await fixture.scheduler.run('project_1');

    // UNKNOWN 归一为不可自动重发：两候选 FAILED，无任何新 submit（零重发）。
    expect(fixture.ports.agnes.submitCount()).toBe(0);
    const agnesCandidates = fixture.videoRepository.candidates.filter((candidate) =>
      candidate.id.startsWith('vtask_agn'),
    );
    expect(agnesCandidates.map((candidate) => candidate.status)).toEqual(['FAILED', 'FAILED']);
    expect(new Set(agnesCandidates.map((candidate) => candidate.errorCode))).toEqual(
      new Set(['MODEL_RESULT_UNAVAILABLE']),
    );
    // 兄弟 Seedance 任务照常由原 Adapter 完成（非重试错误不切换 Provider、不拖累他任务）。
    expect(fixture.ports.seedance.submitCount()).toBe(0);
    expect(fixture.videoRepository.tasks.find((task) => task.id === 'vtask_seed')).toMatchObject({
      errorCode: null,
      phase: 'COMPLETED',
    });
  });
});
