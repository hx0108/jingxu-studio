import { describe, expect, it } from 'vitest';

import type {
  ImageGenerationRequest,
  ImageResultRef,
  ImageTaskStatus,
  ImageTaskSubmission,
} from '../ports/image-model/image-model-types';
import type { ImageModelPort } from '../ports/image-model/image-model-port';
import type { NormalizedModelError } from '../ports/text-model/text-model-types';
import type { MediaUnitOfWorkPort } from '../ports/media/media-repository';
import { InMemoryMediaInvocationRepository } from './in-memory-media-invocation-repository';
import { InMemoryMediaRepository } from './in-memory-media-repository';
import type { MediaFileStorePort, MediaTaskScheduler } from './media-task-scheduler';
import { createMediaTaskScheduler } from './media-task-scheduler';

const hash64 = (seed: string): string => `${seed}_${'.'.repeat(64)}`.slice(0, 64);
const MODEL_ID = 'doubao-seedream-5-0-lite-260128';

/** submit 脚本步骤：SYNC 结果 / ASYNC 任务 / 归一化错误 / 挂起（只被段超时或中止打断）。 */
type SubmitStep =
  | Readonly<{ kind: 'SYNC' }>
  | Readonly<{ kind: 'ASYNC' }>
  | Readonly<{
      kind: 'ERROR';
      code: NormalizedModelError['code'];
      /** 错误原始响应证据（evidenceOf 通道；默认确定性 429 原文）。 */
      evidence?: Readonly<{ bodyText: string; httpStatus: number; truncated: boolean }>;
    }>
  | Readonly<{ kind: 'HANG' }>;

class FakeModelError extends Error {
  public readonly evidence: Readonly<{ bodyText: string; httpStatus: number; truncated: boolean }> | null;
  public readonly normalized: NormalizedModelError;

  public constructor(
    normalized: NormalizedModelError,
    evidence: Readonly<{ bodyText: string; httpStatus: number; truncated: boolean }> | null = null,
  ) {
    super(normalized.code);
    this.name = 'FakeModelError';
    this.evidence = evidence;
    this.normalized = normalized;
  }
}

interface FakePortOptions {
  readonly submits?: readonly SubmitStep[];
  /** 每 tid 首次 poll 返回 PENDING，其后按本计划；默认 SUCCEEDED。 */
  readonly pollPlan?: 'SUCCEEDED' | 'ALWAYS_PENDING' | 'FAILED';
  /** download 前置闸门（挂起以制造迟到下载竞态）。 */
  readonly downloadGate?: Promise<void>;
}

/** 顺序记录 submit/poll/download，供「先留证再轮询」等次序断言。 */
class FakeImageModel implements ImageModelPort {
  public readonly order: string[] = [];
  private submitAttempts = 0;
  private readonly pollCounts = new Map<string, number>();

  public constructor(private readonly options: FakePortOptions = {}) {}

  public validateCredential(): Promise<{ ok: true }> {
    return Promise.resolve({ ok: true });
  }

  public submitCount(): number {
    return this.order.filter((entry) => entry.startsWith('submit:')).length;
  }

  public pollCount(): number {
    return this.order.filter((entry) => entry.startsWith('poll:')).length;
  }

  public async submit(
    request: ImageGenerationRequest,
    signal: AbortSignal,
  ): Promise<ImageTaskSubmission> {
    // 步骤按「尝试次数」取（挂起/抛错的尝试也占用脚本槽位）；未脚本化的
    // 尝试沿用最后一步（[{ASYNC}] 即全异步，避免静默混入 SYNC 触发 MIXED）。
    const index = this.submitAttempts;
    this.submitAttempts += 1;
    const scripted = this.options.submits;
    const step = scripted?.[index] ?? scripted?.[scripted.length - 1] ?? { kind: 'SYNC' as const };
    if (step.kind === 'HANG') {
      await new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason as Error);
          },
          { once: true },
        );
      });
    }
    this.order.push(`submit:${request.invocationId}`);
    if (step.kind === 'ERROR') {
      throw new FakeModelError(
        {
          code: step.code,
          detail: null,
          providerRequestId: null,
          retryable: false,
          userAction: null,
        },
        step.evidence ?? {
          bodyText: `{"error":{"code":"FakeRateLimited","invocation":"${request.invocationId}"}}`,
          httpStatus: 429,
          truncated: false,
        },
      );
    }
    if (step.kind === 'ASYNC') {
      return { kind: 'ASYNC', providerTaskId: `pt_${String(index + 1)}` };
    }
    const result: ImageResultRef = {
      height: 2560,
      providerRequestId: request.invocationId,
      url: `mock://${request.invocationId}`,
      width: 1440,
    };
    return {
      kind: 'SYNC',
      raw: {
        bodyText: `{"id":"${request.invocationId}","usage":{"generated_images":1}}`,
        httpStatus: 200,
        truncated: false,
      },
      result,
      usage: { generatedImages: 1, outputTokens: null },
    };
  }

  public poll(providerTaskId: string): Promise<ImageTaskStatus> {
    const count = (this.pollCounts.get(providerTaskId) ?? 0) + 1;
    this.pollCounts.set(providerTaskId, count);
    this.order.push(`poll:${providerTaskId}`);
    const plan = this.options.pollPlan ?? 'SUCCEEDED';
    if (plan === 'ALWAYS_PENDING') return Promise.resolve({ state: 'PENDING' });
    if (plan === 'FAILED') {
      return Promise.resolve({
        detail: null,
        errorCode: 'MODEL_PROVIDER_ERROR',
        state: 'FAILED',
      });
    }
    return Promise.resolve(
      count === 1
        ? { state: 'PENDING' }
        : {
            result: {
              height: 2560,
              providerRequestId: null,
              url: `mock://${providerTaskId}`,
              width: 1440,
            },
            state: 'SUCCEEDED',
            usage: { generatedImages: 1, outputTokens: null },
          },
    );
  }

  public async download(
    resultRef: ImageResultRef,
    _signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    if (this.options.downloadGate !== undefined) await this.options.downloadGate;
    this.order.push(`download:${resultRef.url}`);
    return { bytes: Uint8Array.from([1, 2, 3, 4]), mimeType: 'image/png' };
  }

  public normalizeError(caught: unknown): NormalizedModelError {
    if (caught instanceof FakeModelError) return caught.normalized;
    const name = caught instanceof Error ? caught.name : '';
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

  public evidenceOf(
    error: unknown,
  ): Readonly<{ bodyText: string | null; httpStatus: number | null; truncated: boolean }> | null {
    return error instanceof FakeModelError ? error.evidence : null;
  }
}

interface Fixture {
  readonly port: FakeImageModel;
  readonly repository: InMemoryMediaRepository;
  readonly scheduler: MediaTaskScheduler;
  readonly writes: readonly { readonly storageRelPath: string }[];
}

interface SeedOptions {
  readonly phase?: 'SUBMITTED' | 'POLLING' | 'DOWNLOADING';
  readonly withEvidence?: boolean;
  readonly shotId?: string;
  readonly taskId?: string;
}

const buildFixture = (
  portOptions: FakePortOptions = {},
  segmentTimeoutMs = 5_000,
  onProjectIdle?: (projectId: string) => Promise<boolean>,
): Fixture => {
  const repository = new InMemoryMediaRepository();
  const unitOfWork: MediaUnitOfWorkPort = {
    run: (work) =>
      work({ invocations: new InMemoryMediaInvocationRepository(), media: repository }),
  };
  const port = new FakeImageModel(portOptions);
  const writes: { byteSize: number; storageRelPath: string }[] = [];
  const fileStore: MediaFileStorePort = {
    writeImage: ({ bytes, projectId }) => {
      const sha256 = hash64(`stored_${String(writes.length + 1)}`);
      const record = {
        byteSize: bytes.byteLength,
        mimeType: 'image/png',
        projectId,
        sha256,
        storageRelPath: `projects/${projectId}/images/${sha256.slice(0, 2)}/${sha256}.png`,
      };
      writes.push({ byteSize: record.byteSize, storageRelPath: record.storageRelPath });
      return Promise.resolve(record);
    },
  };
  let clock = 0;
  const scheduler = createMediaTaskScheduler({
    fileStore,
    imageModel: port,
    mediaUnitOfWork: unitOfWork,
    ...(onProjectIdle === undefined ? {} : { onProjectIdle }),
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
          modelId: MODEL_ID,
          prompt: '雨巷中的少女',
          referenceImages: [],
          size: { height: 2560, width: 1440 },
        }),
    },
    segmentTimeoutMs,
    sleep: () => Promise.resolve(undefined),
  });
  return { port, repository, scheduler, writes };
};

/** 建任务 + 4 个 PENDING 候选（round 与任务一致），可选推进相位与候选级留证。 */
const seedTask = async (
  repository: InMemoryMediaRepository,
  options: SeedOptions = {},
): Promise<string> => {
  const unitOfWork: MediaUnitOfWorkPort = {
    run: (work) =>
      work({ invocations: new InMemoryMediaInvocationRepository(), media: repository }),
  };
  const shotId = options.shotId ?? 'shot_1';
  const task = await unitOfWork.run(({ media }) =>
    media.insertTask({
      candidateCount: 4,
      generationInputHash: hash64('gen'),
      id: options.taskId ?? 'task_1',
      idempotencyKey: `req_${options.taskId ?? 'task_1'}`,
      projectId: 'project_1',
      shotId,
      shotVersionId: 'scv_1',
    }),
  );
  const candidates = await unitOfWork.run(({ media }) =>
    media.insertCandidates({
      candidateIds: ['c_1', 'c_2', 'c_3', 'c_4'].map((id) => `${options.taskId ?? 'task_1'}_${id}`),
      generationInputHash: hash64('gen'),
      modelId: MODEL_ID,
      projectId: 'project_1',
      roundNo: task.roundNo,
      shotId,
      shotVersionId: 'scv_1',
    }),
  );
  const idOf = (index: number): string => candidates[index]?.id ?? `missing_${String(index)}`;
  if (options.withEvidence === true) {
    for (let index = 0; index < candidates.length; index += 1) {
      await unitOfWork.run(({ media }) =>
        media.assignCandidateProviderTask(idOf(index), `pt_${String(index + 1)}`),
      );
    }
  }
  if (options.phase === 'POLLING') {
    await unitOfWork.run(({ media }) => media.markTaskPolling(task.id, 'pt_1'));
  } else if (options.phase === 'DOWNLOADING') {
    await unitOfWork.run(({ media }) => media.markTaskPolling(task.id, 'pt_1'));
    await unitOfWork.run(({ media }) => media.markTaskDownloading(task.id));
  }
  return task.id;
};

const candidateStatuses = (
  repository: InMemoryMediaRepository,
  shotId = 'shot_1',
): readonly string[] =>
  repository.candidates
    .filter((candidate) => candidate.shotId === shotId)
    .map((candidate) => candidate.status);

describe('MediaTaskScheduler 同步 Provider（Seedream 形态）', () => {
  it('同步全链路—4 次独立 submit 逐候选下载落库—任务 COMPLETED—证据为 invocationId', async () => {
    const fixture = buildFixture();
    const taskId = await seedTask(fixture.repository);
    await fixture.scheduler.run('project_1');
    const task = fixture.repository.tasks.find((entry) => entry.id === taskId);
    expect(task).toMatchObject({ errorCode: null, phase: 'COMPLETED' });
    expect(fixture.port.submitCount()).toBe(4);
    expect(fixture.port.pollCount()).toBe(0);
    expect(candidateStatuses(fixture.repository)).toEqual([
      'SUCCEEDED',
      'SUCCEEDED',
      'SUCCEEDED',
      'SUCCEEDED',
    ]);
    const evidenceRefs = new Set(
      fixture.repository.candidates.map((candidate) => candidate.invocationEvidenceRef),
    );
    expect(evidenceRefs.size).toBe(4);
    expect(
      fixture.repository.candidates.every((candidate) => candidate.storageRelPath !== null),
    ).toBe(true);
    expect(fixture.writes).toHaveLength(4);
  });

  it('部分候选失败继续兄弟候选—候选级错误码落库—任务仍 COMPLETED', async () => {
    const fixture = buildFixture({
      submits: [{ kind: 'SYNC' }, { kind: 'ERROR', code: 'MODEL_RATE_LIMITED' }, { kind: 'SYNC' }],
    });
    await seedTask(fixture.repository);
    await fixture.scheduler.run('project_1');
    expect(candidateStatuses(fixture.repository)).toEqual([
      'SUCCEEDED',
      'FAILED',
      'SUCCEEDED',
      'SUCCEEDED',
    ]);
    const failed = fixture.repository.candidates.find((candidate) => candidate.status === 'FAILED');
    expect(failed).toMatchObject({ errorCode: 'MODEL_RATE_LIMITED' });
    expect(fixture.repository.tasks[0]).toMatchObject({ phase: 'COMPLETED' });
  });

  it('段超时—挂起 submit 被段超时中止—候选 MODEL_TIMEOUT—兄弟候选继续', async () => {
    const fixture = buildFixture({ submits: [{ kind: 'HANG' }, { kind: 'SYNC' }] }, 10);
    await seedTask(fixture.repository);
    await fixture.scheduler.run('project_1');
    expect(candidateStatuses(fixture.repository)).toEqual([
      'FAILED',
      'SUCCEEDED',
      'SUCCEEDED',
      'SUCCEEDED',
    ]);
    expect(fixture.repository.candidates[0]).toMatchObject({ errorCode: 'MODEL_TIMEOUT' });
  });

  it('取消—先落 CANCELLED 再中止—迟到下载不落库—零重复提交', async () => {
    let releaseDownload: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const fixture = buildFixture({ downloadGate: gate });
    const taskId = await seedTask(fixture.repository);
    const driven = fixture.scheduler.run('project_1');
    // 等首个 submit+download 挂起后取消（轮询写库直至 gate 阻塞）。
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelled = await fixture.scheduler.cancel('project_1', taskId);
    expect(cancelled).toMatchObject({ phase: 'CANCELLED' });
    releaseDownload();
    await driven;
    expect(fixture.port.submitCount()).toBe(1);
    expect(fixture.writes).toHaveLength(1); // 孤儿文件可接受（空间治理独立 change）
    expect(candidateStatuses(fixture.repository)).toEqual([
      'PENDING',
      'PENDING',
      'PENDING',
      'PENDING',
    ]);
    expect(fixture.repository.tasks[0]).toMatchObject({ phase: 'CANCELLED' });
  });

  it('应用关闭 stop—在飞段中止但任务不落终态—留给启动恢复分类', async () => {
    const fixture = buildFixture({ submits: [{ kind: 'HANG' }] });
    const taskId = await seedTask(fixture.repository);
    const driven = fixture.scheduler.run('project_1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fixture.scheduler.stop();
    await driven;
    expect(fixture.repository.tasks.find((entry) => entry.id === taskId)).toMatchObject({
      phase: 'SUBMITTED',
    });
    expect(fixture.port.submitCount()).toBe(0);
  });
});

describe('MediaTaskScheduler 异步 Provider', () => {
  it('异步全链路—先留证后轮询—任务 POLLING→COMPLETED—证据为 providerTaskId', async () => {
    const fixture = buildFixture({
      submits: [{ kind: 'ASYNC' }, { kind: 'ASYNC' }, { kind: 'ASYNC' }, { kind: 'ASYNC' }],
    });
    await seedTask(fixture.repository);
    await fixture.scheduler.run('project_1');
    expect(fixture.repository.tasks[0]).toMatchObject({
      phase: 'COMPLETED',
      providerTaskId: 'pt_1',
    });
    expect(fixture.port.submitCount()).toBe(4);
    // spec 不变式：全部 submit 留证完成后才出现首次 poll。
    const firstPoll = fixture.port.order.findIndex((entry) => entry.startsWith('poll:'));
    const lastSubmit = fixture.port.order
      .map((entry) => entry.startsWith('submit:'))
      .lastIndexOf(true);
    expect(firstPoll).toBeGreaterThan(lastSubmit);
    expect(fixture.repository.candidates.map((candidate) => candidate.providerTaskId)).toEqual([
      'pt_1',
      'pt_2',
      'pt_3',
      'pt_4',
    ]);
    expect(candidateStatuses(fixture.repository)).toEqual([
      'SUCCEEDED',
      'SUCCEEDED',
      'SUCCEEDED',
      'SUCCEEDED',
    ]);
    expect(
      fixture.repository.candidates.every((candidate) =>
        candidate.invocationEvidenceRef?.startsWith('pt_'),
      ),
    ).toBe(true);
  });

  it('轮询截止—持续 PENDING 到 deadline—候选 MODEL_TIMEOUT', async () => {
    const fixture = buildFixture({
      pollPlan: 'ALWAYS_PENDING',
      submits: [{ kind: 'ASYNC' }],
    });
    await seedTask(fixture.repository);
    await fixture.scheduler.run('project_1');
    expect(fixture.repository.tasks[0]).toMatchObject({ phase: 'COMPLETED' });
    expect(candidateStatuses(fixture.repository)).toEqual(['FAILED', 'FAILED', 'FAILED', 'FAILED']);
    expect(fixture.repository.candidates[0]).toMatchObject({ errorCode: 'MODEL_TIMEOUT' });
  });

  it('poll 终态 FAILED—错误码透传候选', async () => {
    const fixture = buildFixture({ pollPlan: 'FAILED', submits: [{ kind: 'ASYNC' }] });
    await seedTask(fixture.repository);
    await fixture.scheduler.run('project_1');
    expect(fixture.repository.candidates.every((candidate) => candidate.status === 'FAILED')).toBe(
      true,
    );
    expect(fixture.repository.candidates[0]).toMatchObject({ errorCode: 'MODEL_PROVIDER_ERROR' });
  });
});

describe('MediaTaskScheduler 启动恢复（recover）', () => {
  it('SUBMITTED 无留证—标记失败待人工—零 submit（不自动重发）', async () => {
    const fixture = buildFixture();
    const taskId = await seedTask(fixture.repository);
    const outcomes = await fixture.scheduler.recover('project_1');
    expect(outcomes).toEqual([{ action: 'MARKED_FAILED_PENDING_MANUAL', taskId }]);
    expect(fixture.repository.tasks.find((entry) => entry.id === taskId)).toMatchObject({
      errorCode: 'MEDIA_TASK_INTERRUPTED',
      phase: 'FAILED',
    });
    await fixture.scheduler.run('project_1');
    expect(fixture.port.submitCount()).toBe(0);
  });

  it('SUBMITTED 部分留证—无法证明全体已发出—同样标记失败待人工', async () => {
    const fixture = buildFixture();
    const taskId = await seedTask(fixture.repository);
    const unitOfWork: MediaUnitOfWorkPort = {
      run: (work) =>
        work({ invocations: new InMemoryMediaInvocationRepository(), media: fixture.repository }),
    };
    await unitOfWork.run(({ media }) =>
      media.assignCandidateProviderTask('task_1_c_1', 'pt_partial'),
    );
    const outcomes = await fixture.scheduler.recover('project_1');
    expect(outcomes).toEqual([{ action: 'MARKED_FAILED_PENDING_MANUAL', taskId }]);
    expect(fixture.port.submitCount()).toBe(0);
  });

  it('POLLING 全留证—恢复轮询零重发—完成全轮', async () => {
    const fixture = buildFixture({ submits: [{ kind: 'ASYNC' }] });
    const taskId = await seedTask(fixture.repository, { phase: 'POLLING', withEvidence: true });
    const outcomes = await fixture.scheduler.recover('project_1');
    expect(outcomes).toEqual([{ action: 'RESUMED_POLLING', taskId }]);
    await fixture.scheduler.run('project_1');
    expect(fixture.port.submitCount()).toBe(0);
    expect(fixture.port.pollCount()).toBeGreaterThanOrEqual(4);
    expect(candidateStatuses(fixture.repository)).toEqual([
      'SUCCEEDED',
      'SUCCEEDED',
      'SUCCEEDED',
      'SUCCEEDED',
    ]);
    expect(fixture.repository.tasks.find((entry) => entry.id === taskId)).toMatchObject({
      phase: 'COMPLETED',
    });
  });

  it('DOWNLOADING 全留证—经证据恢复完成—SUBMITTED 全留证崩溃窗口零重发续轮询', async () => {
    const downloading = buildFixture({ submits: [{ kind: 'ASYNC' }] });
    const downloadingTask = await seedTask(downloading.repository, {
      phase: 'DOWNLOADING',
      withEvidence: true,
    });
    expect(await downloading.scheduler.recover('project_1')).toEqual([
      { action: 'RESUMED_POLLING', taskId: downloadingTask },
    ]);
    await downloading.scheduler.run('project_1');
    expect(downloading.port.submitCount()).toBe(0);
    expect(candidateStatuses(downloading.repository)).toEqual([
      'SUCCEEDED',
      'SUCCEEDED',
      'SUCCEEDED',
      'SUCCEEDED',
    ]);

    // 崩溃窗口：assign 全部落库但未及 markTaskPolling（SUBMITTED + 全留证）。
    const window = buildFixture({ submits: [{ kind: 'ASYNC' }] });
    await seedTask(window.repository, { withEvidence: true });
    await window.scheduler.run('project_1');
    expect(window.port.submitCount()).toBe(0);
    expect(window.port.pollCount()).toBeGreaterThanOrEqual(4);
    expect(candidateStatuses(window.repository)).toEqual([
      'SUCCEEDED',
      'SUCCEEDED',
      'SUCCEEDED',
      'SUCCEEDED',
    ]);
  });
});

describe('MediaTaskScheduler 队列语义', () => {
  it('蓝图构建失败—任务 FAILED MEDIA_REQUEST_BUILD_FAILED—零 submit', async () => {
    const fixture = buildFixture();
    // 替换 requestBuilder：直接构造第二个调度器复用同一仓储。
    const repository = fixture.repository;
    const unitOfWork: MediaUnitOfWorkPort = {
      run: (work) =>
        work({ invocations: new InMemoryMediaInvocationRepository(), media: repository }),
    };
    const failing = createMediaTaskScheduler({
      fileStore: {
        writeImage: () => Promise.reject(new Error('unreachable')),
      },
      imageModel: fixture.port,
      mediaUnitOfWork: unitOfWork,
      newId: () => 'inv_x',
      nowMs: () => 0,
      pollDeadlineMs: 100,
      pollIntervalMs: 0,
      requestBuilder: {
        build: () => Promise.reject(new Error('MEDIA_BLUEPRINT_SIZE_INVALID')),
      },
      segmentTimeoutMs: 5_000,
      sleep: () => Promise.resolve(undefined),
    });
    await seedTask(repository);
    await failing.run('project_1');
    expect(repository.tasks[0]).toMatchObject({
      errorCode: 'MEDIA_REQUEST_BUILD_FAILED',
      phase: 'FAILED',
    });
    expect(fixture.port.submitCount()).toBe(0);
  });

  it('kick 单飞行串行排空两个任务—whenIdle 可等待', async () => {
    const fixture = buildFixture();
    await seedTask(fixture.repository, { shotId: 'shot_1', taskId: 'task_1' });
    await seedTask(fixture.repository, { shotId: 'shot_2', taskId: 'task_2' });
    fixture.scheduler.kick('project_1');
    await fixture.scheduler.whenIdle('project_1');
    expect(fixture.repository.tasks.every((task) => task.phase === 'COMPLETED')).toBe(true);
    expect(fixture.port.submitCount()).toBe(8);
  });

  it('排空钩子—队列空时消费批次建档继续排空；无批次可推进即收尾退出', async () => {
    const idleCalls: string[] = [];
    // 第一次 idle：模拟批次推进钩子为下一镜头建档（返回 true → 排空循环继续）；
    // 第二次 idle：批次队列已耗尽（返回 false → 排空退出）。
    const fixture = buildFixture({}, 5_000, async (projectId) => {
      idleCalls.push(projectId);
      if (idleCalls.length === 1) {
        await seedTask(fixture.repository, { shotId: 'shot_batch', taskId: 'task_lazy' });
        return true;
      }
      return false;
    });
    await fixture.scheduler.run('project_1');
    expect(idleCalls).toEqual(['project_1', 'project_1']);
    // 钩子建档的成员任务被同一排空循环驱动至终态（惰性建档不漏驱动）。
    const lazy = fixture.repository.tasks.find((task) => task.id === 'task_lazy');
    expect(lazy?.phase).toBe('COMPLETED');
    expect(fixture.port.submitCount()).toBe(4);
  });
});
