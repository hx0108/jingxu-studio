/**
 * 媒体任务调度器（shot-first-frame-image-generation 任务 4.2，design D4）。
 *
 * 确定性状态机驱动——不调用模型做决策，模型只做单段 HTTP（MediaModelPort）：
 * - 同项目任务严格串行（与文本 Job 一致的并发模型），不同项目互不阻塞；
 * - 取消先落 CANCELLED 再中止在飞段，迟到下载经相位复核不落库；
 * - 每段 Provider 调用（submit/poll/download）独立超时；
 * - 每段调用证据两段式落库（media-invocation-evidence design D4）：段前短事务
 *   插 STARTED（含请求快照），候选终态同一事务收尾；中断残留 STARTED 如实保留；
 * - 恢复只信证据：候选已持久化 provider_task_id 才恢复轮询；否则按
 *   MEDIA_TASK_INTERRUPTED 标记失败待人工，绝不自动重发（spec 不变式）。
 */

import type {
  ImageGenerationRequest,
  ImageGenerationUsage,
  ImageRawResponse,
  ImageResultRef,
  ImageTaskStatus,
  ImageTaskSubmission,
} from '../ports/image-model/image-model-types';
import type { MediaModelInvocationRecord } from '../ports/media/media-invocation-repository';
import type { MediaModelPort } from '../ports/media/media-model-port';
import type {
  MediaCandidateRecord,
  MediaRepositories,
  MediaTaskPhase,
  MediaTaskRecord,
  MediaUnitOfWorkPort,
} from '../ports/media/media-repository';
import type { MediaRequestBlueprint } from './media-request-blueprint';

/**
 * 候选媒体字节落盘（组合根包装 ContentAddressedStore.write 并按实例绑定
 * 域命名空间 images|videos——调度器不感知目录布局，视频走 videos）。
 */
export interface MediaFileStorePort {
  readonly writeMedia: (input: {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly projectId: string;
  }) => Promise<{
    readonly byteSize: number;
    readonly mimeType: string;
    readonly sha256: string;
    readonly storageRelPath: string;
  }>;
}

export type MediaRecoveryAction = 'RESUMED_POLLING' | 'MARKED_FAILED_PENDING_MANUAL';

export interface MediaRecoveryOutcome {
  readonly action: MediaRecoveryAction;
  readonly taskId: string;
}

export interface MediaTaskScheduler {
  /** 驱动该项目全部未终态任务直到清空（kick 的内部实现；测试可直接 await）。 */
  run(projectId: string): Promise<void>;
  /** 用户取消：先落 CANCELLED（幂等）再中止在飞段；返回取消后任务行。 */
  cancel(projectId: string, taskId: string): Promise<MediaTaskRecord | null>;
  /** 启动扫描：证据齐全恢复轮询，否则标记失败待人工；随后 kick 后台驱动。 */
  recover(projectId: string): Promise<readonly MediaRecoveryOutcome[]>;
  /** 单飞行触发（沿 ScriptJobScheduler 模式）：已在排空中则不重复触发。 */
  kick(projectId: string): void;
  /** 应用关闭：中止在飞段但不改任务相位——由下次启动 recover 分类。 */
  stop(): Promise<void>;
  whenIdle(projectId: string): Promise<void>;
}

export interface MediaTaskSchedulerDependencies<R = ImageGenerationRequest> {
  /** 候选媒体字节落盘（内容寻址，sha256 校验后才登记；命名空间由组合根绑定）。 */
  readonly fileStore: MediaFileStorePort;
  /** 证据快照/响应原文 sha256（组合根注入；本包不引 node: 模块）。 */
  readonly hashText: (input: string) => string;
  /** 媒体模型 Port（shot-video-generation 任务 1.2 泛化：图片/视频实例同构注入）。 */
  readonly model: MediaModelPort<R>;
  /**
   * 项目队列排空后的批次推进钩子（batch-first-frame-generation 任务 3.2）：
   * 返回 true = 已为批次下一镜头建档（新任务已入列），排空循环继续。
   */
  readonly onProjectIdle?: (projectId: string) => Promise<boolean>;
  readonly mediaUnitOfWork: MediaUnitOfWorkPort;
  readonly newId: () => string;
  readonly nowMs: () => number;
  /** 异步 Provider 单候选轮询截止（超时候选级 MODEL_TIMEOUT）。 */
  readonly pollDeadlineMs: number;
  readonly pollIntervalMs: number;
  readonly requestBuilder: {
    readonly build: (task: MediaTaskRecord) => Promise<MediaRequestBlueprint<R>>;
  };
  /** 单段 Provider 调用（submit/poll/download）超时上限。 */
  readonly segmentTimeoutMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

const TERMINAL_PHASES: ReadonlySet<MediaTaskPhase> = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

const isTerminal = (phase: MediaTaskPhase): boolean => TERMINAL_PHASES.has(phase);

/** 持久化/完整性标记（PersistenceRuntimeError 与内存实现共用 message 前缀约定）。 */
const persistenceMarkerOf = (caught: unknown): string | null => {
  const message = caught instanceof Error ? caught.message : '';
  return message.startsWith('MEDIA_') ? message : null;
};

const TEXT_ENCODER = new TextEncoder();

const encodeUtf8 = (text: string): Uint8Array => TEXT_ENCODER.encode(text);

/** 该候选 SUBMIT 证据行 id（design D2：候选 ref 与收尾对象恒指 SUBMIT 行）。 */
const findSubmitRowId = (
  rows: readonly MediaModelInvocationRecord[],
  candidateId: string,
): string | null =>
  rows.find((row) => row.candidateId === candidateId && row.segmentKind === 'SUBMIT')?.id ?? null;

/** submit 段成功结果证据（D5 raw + usage；SUBMIT 行按 SUCCEEDED 收尾的载荷）。 */
type SubmitOutcomeEvidence = Readonly<{
  providerRequestId: string | null;
  raw: ImageRawResponse | null;
  usage: ImageGenerationUsage;
}>;

export const createMediaTaskScheduler = <R = ImageGenerationRequest>(
  dependencies: MediaTaskSchedulerDependencies<R>,
): MediaTaskScheduler => {
  const { mediaUnitOfWork } = dependencies;
  const drains = new Map<string, Promise<void>>();
  const aborts = new Map<string, AbortController>();
  let stopped = false;

  const readTask = (projectId: string, taskId: string): Promise<MediaTaskRecord | null> =>
    mediaUnitOfWork.run(({ media }) => media.findTaskById(projectId, taskId));

  const attemptFailTask = async (taskId: string, errorCode: string): Promise<void> => {
    try {
      await mediaUnitOfWork.run(({ media }) => media.failTask(taskId, errorCode));
    } catch {
      // 已终态或持久化异常：排空循环的停滞护栏负责暴露后者。
    }
  };

  const finishDriving = async (taskId: string): Promise<void> => {
    try {
      await mediaUnitOfWork.run(({ media }) => media.completeTask(taskId));
    } catch {
      // 已终态（取消/失败竞态）——幂等收尾。
    }
  };

  /** 中止后的停机决策：任务已终态（用户取消）或应用关闭则静默，否则按中断落终态。 */
  const stopForAbort = async (projectId: string, taskId: string): Promise<void> => {
    const fresh = await readTask(projectId, taskId);
    if (fresh !== null && isTerminal(fresh.phase)) return;
    if (stopped) return;
    await attemptFailTask(taskId, 'MEDIA_TASK_INTERRUPTED');
  };

  /**
   * 候选落库的事务内相位复核：与 cancelTask 同在 BEGIN IMMEDIATE 下串行，
   * 关闭「复核通过→取消落库→候选写入」的迟到写竞态。返回任务是否仍可驱动。
   */
  const writeCandidateOutcome = async (
    projectId: string,
    taskId: string,
    write: (repos: MediaRepositories) => Promise<unknown>,
  ): Promise<boolean> =>
    mediaUnitOfWork
      .run(async (repos) => {
        const fresh = await repos.media.findTaskById(projectId, taskId);
        if (fresh === null || isTerminal(fresh.phase)) return false;
        await write(repos);
        return true;
      })
      .catch(async () => {
        await attemptFailTask(taskId, 'MEDIA_TASK_INTERRUPTED');
        return false;
      });

  /**
   * 单段调用超时包装：段内信号 = 任务级取消信号 ∨ 段超时。超时 reason 的
   * name='TimeoutError'（Adapter 按此归一 MODEL_TIMEOUT）；取消沿用 AbortError。
   */
  const runSegment = async <T>(
    parentSignal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const combined = new AbortController();
    const onParentAbort = (): void => {
      combined.abort(parentSignal.reason);
    };
    if (parentSignal.aborted) combined.abort(parentSignal.reason);
    else parentSignal.addEventListener('abort', onParentAbort);
    const timer = setTimeout(() => {
      const reason = new Error('媒体调用段超时');
      reason.name = 'TimeoutError';
      combined.abort(reason);
    }, dependencies.segmentTimeoutMs);
    try {
      return await work(combined.signal);
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  };

  const isCancelled = (caught: unknown): boolean =>
    caught instanceof Error && caught.name === 'AbortError';

  /** SUBMIT 行按成功收尾（raw/usage 落列）——成功三写与下载段失败补收尾共用。 */
  const finishSubmitSucceeded = async (
    repos: MediaRepositories,
    submitRowId: string,
    outcome: SubmitOutcomeEvidence,
  ): Promise<void> => {
    await repos.invocations.finishTerminal(submitRowId, {
      status: 'SUCCEEDED',
      finishedAt: new Date(dependencies.nowMs()).toISOString(),
      providerRequestId: outcome.providerRequestId,
      providerReportedGeneratedImages: outcome.usage.generatedImages,
      providerReportedOutputTokens: outcome.usage.outputTokens,
      rawResponseBlob: outcome.raw === null ? null : encodeUtf8(outcome.raw.bodyText),
      rawResponseSha256: outcome.raw === null ? null : dependencies.hashText(outcome.raw.bodyText),
      rawResponseTruncated: outcome.raw?.truncated ?? false,
      responseHttpStatus: outcome.raw?.httpStatus ?? null,
    });
  };

  /** 段失败归一处理。返回 true = 停止驱动该任务；false = 继续兄弟候选。 */
  const onSegmentFailure = async (
    projectId: string,
    taskId: string,
    candidateId: string,
    submitRowId: string,
    segmentRowId: string | null,
    caught: unknown,
    submitOutcome?: SubmitOutcomeEvidence,
  ): Promise<boolean> => {
    if (persistenceMarkerOf(caught) !== null || isCancelled(caught)) {
      // 持久化/完整性标记或取消：任务级停机，不写候选，证据行停留 STARTED 如实。
      await stopForAbort(projectId, taskId);
      return true;
    }
    const normalized = dependencies.model.normalizeError(caught);
    if (normalized.code === 'MODEL_CANCELLED') {
      await stopForAbort(projectId, taskId);
      return true;
    }
    // Provider 归一化错误：候选级失败，同轮其余候选继续（spec 不变式）；
    // 失败段证据行与候选终态同一事务收尾（design D4，原文入 blob）。
    const evidence = dependencies.model.evidenceOf(caught);
    await writeCandidateOutcome(projectId, taskId, async (repos) => {
      await repos.media.completeCandidateFailed(candidateId, {
        errorCode: normalized.code,
        invocationEvidenceRef: submitRowId,
      });
      if (segmentRowId !== null) {
        await repos.invocations.finishTerminal(segmentRowId, {
          status: 'FAILED',
          errorCode: normalized.code,
          finishedAt: new Date(dependencies.nowMs()).toISOString(),
          responseHttpStatus: evidence?.httpStatus ?? null,
          rawResponseBlob: evidence?.bodyText == null ? null : encodeUtf8(evidence.bodyText),
          rawResponseSha256:
            evidence?.bodyText == null ? null : dependencies.hashText(evidence.bodyText),
          rawResponseTruncated: evidence?.truncated ?? false,
        });
      }
      if (submitOutcome !== undefined) {
        // 下载段失败补收尾（2026-08-20 真实联调修订）：submit 段实际已成功
        // （resultUrl 在手），同一事务按 SUCCEEDED 落 raw/usage——否则成功响应
        // 证据随下载失败永久丢失。
        await finishSubmitSucceeded(repos, submitRowId, submitOutcome);
      }
    });
    return false;
  };

  /** 候选 SUBMIT 证据行 id 解析（ASYNC/恢复路径无 invocationId 上下文时统一入口）。 */
  const submitRowIdOf = async (
    taskId: string,
    candidateId: string,
    fallback: string,
  ): Promise<string> => {
    const rows = await mediaUnitOfWork.run(({ invocations }) => invocations.listByTaskId(taskId));
    return findSubmitRowId(rows, candidateId) ?? fallback;
  };

  /** 下载→落盘→（事务内相位复核）候选成功落库。返回是否继续驱动。 */
  const settleDownload = async (
    task: MediaTaskRecord,
    candidate: MediaCandidateRecord,
    submitRef: string,
    result: ImageResultRef,
    signal: AbortSignal,
    submitOutcome: SubmitOutcomeEvidence,
  ): Promise<boolean> => {
    // D4 第一段：DOWNLOAD 证据行与相位推进同一短事务插入（快照=D2 口径）。
    const downloadInvocationId = dependencies.newId();
    const downloadSnapshot = JSON.stringify({
      providerRequestId: result.providerRequestId,
      resultUrl: result.url,
    });
    try {
      await mediaUnitOfWork.run(async (repos) => {
        // 懒转移 DOWNLOADING（幂等）：首次进入下载段的候选负责推进相位。
        await repos.media.markTaskDownloading(task.id);
        await repos.invocations.insert({
          candidateId: candidate.id,
          id: downloadInvocationId,
          mediaTaskId: task.id,
          modelId: candidate.modelId,
          requestSha256: dependencies.hashText(downloadSnapshot),
          requestSnapshotJson: downloadSnapshot,
          segmentKind: 'DOWNLOAD',
        });
      });
    } catch {
      await stopForAbort(task.projectId, task.id);
      return false;
    }
    let stored: Awaited<ReturnType<MediaFileStorePort['writeMedia']>>;
    try {
      const download = await runSegment(signal, (segment) =>
        dependencies.model.download(result, segment),
      );
      stored = await dependencies.fileStore.writeMedia({
        bytes: download.bytes,
        mimeType: download.mimeType,
        projectId: task.projectId,
      });
    } catch (caught) {
      // onSegmentFailure 语义为「true=停机」；本函数返回「true=继续」，需取反。
      // 下载段失败同事务三写（design D4 2026-08-20 修订）：候选 FAILED + DOWNLOAD
      // 行 FAILED + SUBMIT 行按成功收尾（submit 实际已成功，raw/usage 不丢失）。
      const stop = await onSegmentFailure(
        task.projectId,
        task.id,
        candidate.id,
        await submitRowIdOf(task.id, candidate.id, submitRef),
        downloadInvocationId,
        caught,
        submitOutcome,
      );
      return !stop;
    }
    // 成功一笔事务三写（design D4）：候选 SUCCEEDED + SUBMIT 行收尾（raw/usage）
    // + DOWNLOAD 行收尾（sha256=落盘哈希；blob 恒 NULL——字节只在内容寻址存储）。
    return writeCandidateOutcome(task.projectId, task.id, async (repos) => {
      const submitRowId = findSubmitRowId(
        await repos.invocations.listByTaskId(task.id),
        candidate.id,
      );
      await repos.media.completeCandidateSucceeded(candidate.id, {
        byteSize: stored.byteSize,
        fileSha256: stored.sha256,
        height: result.height,
        invocationEvidenceRef: submitRowId ?? submitRef,
        mimeType: stored.mimeType,
        storageRelPath: stored.storageRelPath,
        width: result.width,
      });
      if (submitRowId !== null) {
        await finishSubmitSucceeded(repos, submitRowId, submitOutcome);
      }
      await repos.invocations.finishTerminal(downloadInvocationId, {
        status: 'SUCCEEDED',
        finishedAt: new Date(dependencies.nowMs()).toISOString(),
        rawResponseSha256: stored.sha256,
      });
    });
  };

  /** 异步证据驱动：轮询单候选到终态（含轮询截止），再下载落库。返回是否继续。 */
  const drivePolledCandidate = async (
    task: MediaTaskRecord,
    candidate: MediaCandidateRecord,
    providerTaskId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    // D2：候选 ref 恒指 SUBMIT 证据行（查无行时回退 providerTaskId，保持既有形态）。
    const submitRef = await submitRowIdOf(task.id, candidate.id, providerTaskId);
    const deadline = dependencies.nowMs() + dependencies.pollDeadlineMs;
    for (;;) {
      if (signal.aborted) {
        await stopForAbort(task.projectId, task.id);
        return false;
      }
      let status: ImageTaskStatus;
      try {
        status = await runSegment(signal, (segment) =>
          dependencies.model.poll(providerTaskId, segment),
        );
      } catch (caught) {
        const stop = await onSegmentFailure(
          task.projectId,
          task.id,
          candidate.id,
          submitRef,
          // 轮询段无证据行（POLL 枚举预留，Seedream 恒 SYNC 不触发）。
          null,
          caught,
        );
        return !stop;
      }
      if (status.state === 'SUCCEEDED') {
        return settleDownload(task, candidate, submitRef, status.result, signal, {
          providerRequestId: providerTaskId,
          raw: null,
          usage: status.usage,
        });
      }
      if (status.state === 'FAILED') {
        return writeCandidateOutcome(task.projectId, task.id, ({ media }) =>
          media.completeCandidateFailed(candidate.id, {
            errorCode: status.errorCode,
            invocationEvidenceRef: submitRef,
          }),
        );
      }
      if (dependencies.nowMs() >= deadline) {
        return writeCandidateOutcome(task.projectId, task.id, ({ media }) =>
          media.completeCandidateFailed(candidate.id, {
            errorCode: 'MODEL_TIMEOUT',
            invocationEvidenceRef: submitRef,
          }),
        );
      }
      await dependencies.sleep(dependencies.pollIntervalMs);
    }
  };

  /** 证据驱动循环：逐个推进 PENDING 且已留证候选；证据缺失即按中断停机。 */
  const driveFromEvidence = async (task: MediaTaskRecord, signal: AbortSignal): Promise<void> => {
    for (;;) {
      const candidates = await mediaUnitOfWork.run(({ media }) =>
        media.listCandidates(task.shotId),
      );
      const pending = candidates.filter(
        (entry) => entry.roundNo === task.roundNo && entry.status === 'PENDING',
      );
      const next = pending[0];
      if (next === undefined) break;
      const providerTaskId = next.providerTaskId;
      if (providerTaskId === null) {
        await stopForAbort(task.projectId, task.id);
        return;
      }
      const proceed = await drivePolledCandidate(task, next, providerTaskId, signal);
      if (!proceed) return;
    }
    await finishDriving(task.id);
  };

  /** 全新提交：蓝图构建 → 逐候选 submit（首个返回揭示同步/异步形态）。 */
  const driveFreshSubmits = async (
    task: MediaTaskRecord,
    pending: readonly MediaCandidateRecord[],
    signal: AbortSignal,
  ): Promise<void> => {
    let blueprint: MediaRequestBlueprint<R>;
    try {
      blueprint = await dependencies.requestBuilder.build(task);
    } catch {
      await attemptFailTask(task.id, 'MEDIA_REQUEST_BUILD_FAILED');
      return;
    }
    let mode: 'SYNC' | 'ASYNC' | null = null;
    const providerTaskIds = new Map<string, string>();
    for (const candidate of pending) {
      const invocationId = dependencies.newId();
      const request = blueprint.buildRequest(invocationId);
      // D4 第一段：submit 段前短事务插 SUBMIT STARTED（快照=D3 口径，不含字节与凭据；
      // 快照字段集由域构建器产出——视频含首帧哈希/时长，图片含参考图哈希/尺寸）。
      const submitSnapshot = blueprint.submitSnapshotJson;
      try {
        await mediaUnitOfWork.run(({ invocations }) =>
          invocations.insert({
            candidateId: candidate.id,
            id: invocationId,
            mediaTaskId: task.id,
            modelId: blueprint.modelId,
            requestSha256: dependencies.hashText(submitSnapshot),
            requestSnapshotJson: submitSnapshot,
            segmentKind: 'SUBMIT',
          }),
        );
      } catch {
        await stopForAbort(task.projectId, task.id);
        return;
      }
      let submission: ImageTaskSubmission;
      try {
        submission = await runSegment(signal, (segment) =>
          dependencies.model.submit(request, segment),
        );
      } catch (caught) {
        const stop = await onSegmentFailure(
          task.projectId,
          task.id,
          candidate.id,
          invocationId,
          invocationId,
          caught,
        );
        if (stop) return;
        continue;
      }
      if (submission.kind === 'SYNC') {
        if (mode === 'ASYNC') {
          await attemptFailTask(task.id, 'MEDIA_TASK_PROVIDER_MODE_MIXED');
          return;
        }
        mode = 'SYNC';
        const proceed = await settleDownload(
          task,
          candidate,
          invocationId,
          submission.result,
          signal,
          {
            providerRequestId: submission.result.providerRequestId,
            raw: submission.raw,
            usage: submission.usage,
          },
        );
        if (!proceed) return;
        continue;
      }
      if (mode === 'SYNC') {
        await attemptFailTask(task.id, 'MEDIA_TASK_PROVIDER_MODE_MIXED');
        return;
      }
      mode = 'ASYNC';
      try {
        // spec 不变式：taskId 先持久化再轮询；assign 失败即留证缺失，按中断停机。
        await mediaUnitOfWork.run(({ media }) =>
          media.assignCandidateProviderTask(candidate.id, submission.providerTaskId),
        );
        providerTaskIds.set(candidate.id, submission.providerTaskId);
      } catch {
        await stopForAbort(task.projectId, task.id);
        return;
      }
    }
    if (mode === 'ASYNC') {
      const firstTaskId = [...providerTaskIds.values()][0];
      if (firstTaskId !== undefined) {
        try {
          await mediaUnitOfWork.run(({ media }) => media.markTaskPolling(task.id, firstTaskId));
        } catch {
          // 已转移/终态竞态：证据已落，继续由证据驱动接管。
        }
      }
      await driveFromEvidence(task, signal);
      return;
    }
    await finishDriving(task.id);
  };

  const advance = async (projectId: string, taskId: string, signal: AbortSignal): Promise<void> => {
    const task = await readTask(projectId, taskId);
    if (task === null || isTerminal(task.phase)) return;
    const candidates = await mediaUnitOfWork.run(({ media }) => media.listCandidates(task.shotId));
    const pending = candidates.filter(
      (entry) => entry.roundNo === task.roundNo && entry.status === 'PENDING',
    );
    if (pending.length === 0) {
      await finishDriving(taskId);
      return;
    }
    if (task.phase === 'SUBMITTED') {
      const evidenced = pending.filter((entry) => entry.providerTaskId !== null);
      if (evidenced.length === pending.length) {
        // 崩溃窗口恢复：全部提交已留证但未及转 POLLING——零重发续轮询。
        const firstTaskId = evidenced[0]?.providerTaskId;
        if (typeof firstTaskId === 'string') {
          try {
            await mediaUnitOfWork.run(({ media }) => media.markTaskPolling(taskId, firstTaskId));
          } catch {
            // 已转移/终态竞态：证据驱动自行接管。
          }
        }
        await driveFromEvidence(task, signal);
        return;
      }
      if (evidenced.length > 0) {
        // 部分留证：无法证明全体已发出，不自动重发（spec 场景）。
        await attemptFailTask(taskId, 'MEDIA_TASK_INTERRUPTED');
        return;
      }
      await driveFreshSubmits(task, pending, signal);
      return;
    }
    if (pending.some((entry) => entry.providerTaskId === null)) {
      await attemptFailTask(taskId, 'MEDIA_TASK_INTERRUPTED');
      return;
    }
    await driveFromEvidence(task, signal);
  };

  const driveTask = async (projectId: string, taskId: string): Promise<void> => {
    const controller = new AbortController();
    aborts.set(taskId, controller);
    try {
      await advance(projectId, taskId, controller.signal);
    } catch {
      // 未预期异常按中断落终态，避免队列卡死；停滞护栏负责暴露持续失败。
      await attemptFailTask(taskId, 'MEDIA_TASK_INTERRUPTED');
    } finally {
      aborts.delete(taskId);
    }
  };

  const drainProject = async (projectId: string): Promise<void> => {
    let lastTaskId: string | null = null;
    let repeats = 0;
    for (;;) {
      const tasks = await mediaUnitOfWork.run(({ media }) => media.listUnfinishedTasks(projectId));
      if (stopped) return;
      const next = tasks[0];
      if (next === undefined) {
        // 队列排空 ≠ 项目无事可做：RUNNING 批次在此惰性建档下一镜头（design D1-C）。
        const progressed = await dependencies.onProjectIdle?.(projectId);
        if (progressed === true) continue;
        return;
      }
      // 停滞护栏：同一任务连续驱动仍不清空即抛出（任务应总被推向终态）。
      if (next.id === lastTaskId) {
        repeats += 1;
        if (repeats > 2) throw new Error(`MEDIA_SCHEDULER_STALLED:${next.id}`);
      } else {
        lastTaskId = next.id;
        repeats = 0;
      }
      await driveTask(projectId, next.id);
    }
  };

  return {
    run: drainProject,

    cancel: async (projectId, taskId) => {
      // 先落 CANCELLED（幂等）再中止在飞段；迟到下载由事务内相位复核拦下。
      try {
        await mediaUnitOfWork.run(({ media }) => media.cancelTask(taskId));
      } catch {
        // 已终态——幂等取消。
      }
      const controller = aborts.get(taskId);
      if (controller !== undefined) {
        const reason = new Error('媒体任务已取消');
        reason.name = 'AbortError';
        controller.abort(reason);
      }
      return readTask(projectId, taskId);
    },

    recover: async (projectId) => {
      const tasks = await mediaUnitOfWork.run(({ media }) => media.listUnfinishedTasks(projectId));
      const outcomes: MediaRecoveryOutcome[] = [];
      for (const task of tasks) {
        const candidates = await mediaUnitOfWork.run(({ media }) =>
          media.listCandidates(task.shotId),
        );
        const pending = candidates.filter(
          (entry) => entry.roundNo === task.roundNo && entry.status === 'PENDING',
        );
        const resumable =
          (task.phase === 'POLLING' || task.phase === 'DOWNLOADING') &&
          pending.every((entry) => entry.providerTaskId !== null);
        if (resumable) {
          outcomes.push({ action: 'RESUMED_POLLING', taskId: task.id });
        } else {
          // SUBMITTED 无证据（含同步 Provider 崩溃窗口）：不自动重发，待人工。
          await attemptFailTask(task.id, 'MEDIA_TASK_INTERRUPTED');
          outcomes.push({ action: 'MARKED_FAILED_PENDING_MANUAL', taskId: task.id });
        }
      }
      return outcomes;
    },

    kick: (projectId) => {
      if (stopped || drains.has(projectId)) return;
      const drain = drainProject(projectId).finally(() => {
        drains.delete(projectId);
      });
      drains.set(projectId, drain);
    },

    stop: async () => {
      stopped = true;
      const reason = new Error('应用关闭');
      reason.name = 'AbortError';
      for (const controller of aborts.values()) {
        controller.abort(reason);
      }
      await Promise.allSettled([...drains.values()]);
    },

    whenIdle: (projectId) => drains.get(projectId) ?? Promise.resolve(),
  };
};
