import { describe, expect, it } from 'vitest';

import type { MediaModelPort } from '../ports/media/media-model-port';
import type { MediaUnitOfWorkPort } from '../ports/media/media-repository';
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
type PollPlan = 'SUCCEEDED' | 'ALWAYS_PENDING' | 'ERROR';

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
): Promise<{ candidateId: string; fileSha256: string }> => {
  const inserted = await unitOfWork.run(({ media }) =>
    media.insertCandidates({
      candidateIds: ['img_1'],
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

/** 建视频任务 + 2 个 PENDING 候选（首帧锚点对 + 档位时长 8s 冻结）。 */
const seedVideoTask = async (
  unitOfWork: MediaUnitOfWorkPort,
  shotId = 'shot_1',
  taskId = 'vtask_1',
): Promise<string> => {
  const anchor = await seedFirstFrame(unitOfWork, shotId);
  const task = await unitOfWork.run(({ video }) =>
    video.insertTask({
      batchId: null,
      candidateCount: VIDEO_CANDIDATE_COUNT,
      generationInputHash: hash64('vgen'),
      id: taskId,
      idempotencyKey: `vreq_${taskId}`,
      projectId: 'project_1',
      shotId,
      shotVersionId: 'scv_1',
    }),
  );
  await unitOfWork.run(({ video }) =>
    video.insertCandidates({
      candidateIds: ['vc_1', 'vc_2'],
      firstFrameCandidateId: anchor.candidateId,
      firstFrameFileSha256: anchor.fileSha256,
      generationInputHash: hash64('vgen'),
      modelId: VIDEO_MODEL_ID,
      projectId: 'project_1',
      requestedDurationSec: 8,
      roundNo: task.roundNo,
      shotId,
      shotVersionId: 'scv_1',
    }),
  );
  return task.id;
};

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

const buildBlueprintFixture = (shot: StoryboardShotSnapshot | null): BlueprintFixture => {
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
    // 快照冻结字段序（requestSha256 稳定性）：时长/首帧锚点对/模型/提示词/分辨率。
    expect(blueprint.submitSnapshotJson).toBe(
      `{"durationSec":8,"firstFrameCandidateId":"img_1","firstFrameFileSha256":"${IMG_SHA_1}","modelId":"${VIDEO_MODEL_ID}","prompt":"少女撑伞走过雨巷，怅惘\\n叙事目的：建立雨巷氛围\\n运镜：推轨","resolution":{"height":1920,"width":1080}}`,
    );
    expect(fixture.readCalls).toEqual([
      { fileSha256: IMG_SHA_1, mimeType: 'image/png', projectId: 'project_1' },
    ]);
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
