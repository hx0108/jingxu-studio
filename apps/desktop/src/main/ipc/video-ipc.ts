import { randomUUID } from 'node:crypto';

import {
  appResultSchema,
  cancelVideoBatchInputSchema,
  cancelVideoExportInputSchema,
  createVideoTimelineInputSchema,
  generateVideoCandidatesInputSchema,
  generateVideosForShotsInputSchema,
  getVideoTaskInputSchema,
  getVideoExportJobInputSchema,
  getVideoTimelineInputSchema,
  importVideoBackgroundMusicInputSchema,
  listStoryboardVideoStatesInputSchema,
  listVideoCandidatesInputSchema,
  mediaBatchViewSchema,
  mediaTaskViewSchema,
  selectVideoCandidateInputSchema,
  startVideoExportInputSchema,
  updateVideoTimelineInputSchema,
  storyboardVideoStatesSchema,
  VIDEO_IPC_CHANNELS,
  videoAudioAssetSummarySchema,
  videoCandidateViewSchema,
  videoExportJobSchema,
  videoTimelineSummarySchema,
} from '@jingxu/contracts';
import type {
  AppResultDto,
  CancelVideoBatchInputDto,
  CancelVideoExportInputDto,
  CreateVideoTimelineInputDto,
  GenerateVideoCandidatesInputDto,
  GenerateVideosForShotsInputDto,
  GetVideoTaskInputDto,
  GetVideoExportJobInputDto,
  GetVideoTimelineInputDto,
  ImportVideoBackgroundMusicInputDto,
  ListStoryboardVideoStatesInputDto,
  ListVideoCandidatesInputDto,
  MediaBatchViewDto,
  MediaTaskViewDto,
  SelectVideoCandidateInputDto,
  StartVideoExportInputDto,
  StoryboardVideoStatesDto,
  UpdateVideoTimelineInputDto,
  VideoAudioAssetSummaryDto,
  VideoCandidateViewDto,
  VideoExportJobDto,
  VideoTimelineSummaryDto,
} from '@jingxu/contracts';
import { z, type ZodType } from 'zod';

import { assertTrustedIpcSender, parseSingleIpcArgument, type IpcEvent } from './ipc-boundary';

export { VIDEO_IPC_CHANNELS };

export interface VideoIpcRegistrar {
  handle(
    channel: string,
    listener: (event: IpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>,
  ): void;
}

/** Main 注入的 Video 用例（七方法白名单）；IPC Host 不接触 Repository、字节存储或 SQL。 */
export interface VideoIpcService {
  readonly generateVideoCandidates: (
    input: GenerateVideoCandidatesInputDto,
    traceId: string,
  ) => Promise<AppResultDto<MediaTaskViewDto>>;
  readonly listVideoCandidates: (
    input: ListVideoCandidatesInputDto,
    traceId: string,
  ) => Promise<AppResultDto<VideoCandidateViewDto[]>>;
  readonly selectVideoCandidate: (
    input: SelectVideoCandidateInputDto,
    traceId: string,
  ) => Promise<AppResultDto<VideoCandidateViewDto[]>>;
  readonly getVideoTask: (
    input: GetVideoTaskInputDto,
    traceId: string,
  ) => Promise<AppResultDto<MediaTaskViewDto>>;
  readonly generateVideosForShots: (
    input: GenerateVideosForShotsInputDto,
    traceId: string,
  ) => Promise<AppResultDto<MediaBatchViewDto>>;
  readonly cancelVideoBatch: (
    input: CancelVideoBatchInputDto,
    traceId: string,
  ) => Promise<AppResultDto<MediaBatchViewDto>>;
  readonly listStoryboardVideoStates: (
    input: ListStoryboardVideoStatesInputDto,
    traceId: string,
  ) => Promise<AppResultDto<StoryboardVideoStatesDto>>;
  readonly createTimeline: (
    input: CreateVideoTimelineInputDto,
    traceId: string,
  ) => Promise<AppResultDto<VideoTimelineSummaryDto>>;
  readonly getTimeline: (
    input: GetVideoTimelineInputDto,
    traceId: string,
  ) => Promise<AppResultDto<VideoTimelineSummaryDto>>;
  readonly updateTimeline: (
    input: UpdateVideoTimelineInputDto,
    traceId: string,
  ) => Promise<AppResultDto<VideoTimelineSummaryDto>>;
  readonly importBackgroundMusic: (
    input: ImportVideoBackgroundMusicInputDto,
    traceId: string,
  ) => Promise<AppResultDto<VideoAudioAssetSummaryDto>>;
  readonly startExport: (
    input: StartVideoExportInputDto,
    traceId: string,
  ) => Promise<AppResultDto<VideoExportJobDto>>;
  readonly getExportJob: (
    input: GetVideoExportJobInputDto,
    traceId: string,
  ) => Promise<AppResultDto<VideoExportJobDto>>;
  readonly cancelExport: (
    input: CancelVideoExportInputDto,
    traceId: string,
  ) => Promise<AppResultDto<VideoExportJobDto>>;
}

export interface VideoStartupWriteGate {
  isWriteReady(): boolean;
}

export interface VideoIpcTraceIds {
  newTraceId(): string;
}

interface InFlightEntry<T> {
  readonly promise: Promise<T>;
  readonly signature: string;
}

/** 同 requestId 并发 singleflight：同签名复用同结果，异签名判 REQUEST_ID_REUSED。 */
class VideoRequestCoordinator {
  readonly #inFlight = new Map<string, InFlightEntry<unknown>>();

  public run<T>(
    requestId: string,
    signature: string,
    operation: () => Promise<T>,
    conflict: () => T,
  ): Promise<T> {
    const found = this.#inFlight.get(requestId);
    if (found !== undefined) {
      return found.signature === signature
        ? (found.promise as Promise<T>)
        : Promise.resolve(conflict());
    }
    const promise = Promise.resolve().then(operation);
    const entry: InFlightEntry<T> = { promise, signature };
    this.#inFlight.set(requestId, entry);
    const cleanup = (): void => {
      if (this.#inFlight.get(requestId) === entry) this.#inFlight.delete(requestId);
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }
}

const errorResult = <T>(
  code:
    | 'IPC_INVALID_REQUEST'
    | 'PROJECT_PERSISTENCE_FAILED'
    | 'REQUEST_ID_REUSED'
    | 'STARTUP_WRITE_BLOCKED',
  traceId: string,
): AppResultDto<T> => {
  const messages = {
    IPC_INVALID_REQUEST: ['请求参数无效', '请检查输入后重试', false],
    PROJECT_PERSISTENCE_FAILED: ['视频操作失败', '请重试；若持续失败，请检查启动状态', true],
    REQUEST_ID_REUSED: ['请求 ID 已用于其他操作', '请刷新后重新提交', false],
    STARTUP_WRITE_BLOCKED: ['应用尚未进入可写状态', '请先处理启动故障后重试', true],
  } as const;
  const [message, userAction, retryable] = messages[code];
  return {
    error: { code, fieldErrors: null, message, retryable, traceId, userAction },
    ok: false,
  };
};

const parseOutput = async <T>(
  schema: ZodType<AppResultDto<T>>,
  operation: () => Promise<AppResultDto<T>>,
  traceId: string,
): Promise<AppResultDto<T>> => {
  try {
    const parsed = schema.safeParse(await operation());
    return parsed.success ? parsed.data : errorResult<T>('PROJECT_PERSISTENCE_FAILED', traceId);
  } catch {
    return errorResult<T>('PROJECT_PERSISTENCE_FAILED', traceId);
  }
};

/**
 * 注册七个固定 video channel，并按 sender、DTO、启动门、Application、输出依次校验。
 * 七方法（含只读查询）全部受启动写门约束——故障态下视频面板统一不可用。
 */
export const registerVideoIpc = (
  registrar: VideoIpcRegistrar,
  service: VideoIpcService,
  startupGate: VideoStartupWriteGate,
  trustedUrl: string,
  traceIds: VideoIpcTraceIds = { newTraceId: randomUUID },
): void => {
  const coordinator = new VideoRequestCoordinator();
  const taskResult = appResultSchema(mediaTaskViewSchema);
  const candidatesResult = appResultSchema(z.array(videoCandidateViewSchema));
  const batchResult = appResultSchema(mediaBatchViewSchema);
  const storyboardStatesResult = appResultSchema(storyboardVideoStatesSchema);
  const timelineResult = appResultSchema(videoTimelineSummarySchema);
  const audioResult = appResultSchema(videoAudioAssetSummarySchema);
  const exportResult = appResultSchema(videoExportJobSchema);

  const registerQuery = <TInput, TOutput>(
    channel: string,
    inputSchema: ZodType<TInput>,
    outputSchema: ZodType<AppResultDto<TOutput>>,
    invoke: (input: TInput, traceId: string) => Promise<AppResultDto<TOutput>>,
  ): void => {
    registrar.handle(channel, (event, ...arguments_) => {
      assertTrustedIpcSender(event, trustedUrl);
      const traceId = traceIds.newTraceId();
      const input = parseSingleIpcArgument(inputSchema, arguments_);
      if (input === null) return Promise.resolve(errorResult('IPC_INVALID_REQUEST', traceId));
      if (!startupGate.isWriteReady()) {
        return Promise.resolve(errorResult('STARTUP_WRITE_BLOCKED', traceId));
      }
      return parseOutput(outputSchema, () => invoke(input, traceId), traceId);
    });
  };

  const registerCommand = <TInput extends { readonly requestId: string }, TOutput>(
    channel: string,
    inputSchema: ZodType<TInput>,
    outputSchema: ZodType<AppResultDto<TOutput>>,
    invoke: (input: TInput, traceId: string) => Promise<AppResultDto<TOutput>>,
    signatureOf: (input: TInput) => string,
  ): void => {
    registrar.handle(channel, (event, ...arguments_) => {
      assertTrustedIpcSender(event, trustedUrl);
      const traceId = traceIds.newTraceId();
      const input = parseSingleIpcArgument(inputSchema, arguments_);
      if (input === null) return Promise.resolve(errorResult('IPC_INVALID_REQUEST', traceId));
      if (!startupGate.isWriteReady()) {
        return Promise.resolve(errorResult('STARTUP_WRITE_BLOCKED', traceId));
      }
      return coordinator.run(
        input.requestId,
        signatureOf(input),
        () => parseOutput(outputSchema, () => invoke(input, traceId), traceId),
        () => errorResult('REQUEST_ID_REUSED', traceId),
      );
    });
  };

  registerCommand(
    VIDEO_IPC_CHANNELS.generateVideoCandidates,
    generateVideoCandidatesInputSchema,
    taskResult,
    (input, traceId) => service.generateVideoCandidates(input, traceId),
    (input) => `video.generateVideoCandidates:${JSON.stringify(input)}`,
  );
  registerCommand(
    VIDEO_IPC_CHANNELS.selectVideoCandidate,
    selectVideoCandidateInputSchema,
    candidatesResult,
    (input, traceId) => service.selectVideoCandidate(input, traceId),
    (input) => `video.selectVideoCandidate:${JSON.stringify(input)}`,
  );
  registerCommand(
    VIDEO_IPC_CHANNELS.generateVideosForShots,
    generateVideosForShotsInputSchema,
    batchResult,
    (input, traceId) => service.generateVideosForShots(input, traceId),
    (input) => `video.generateVideosForShots:${JSON.stringify(input)}`,
  );
  registerCommand(
    VIDEO_IPC_CHANNELS.cancelVideoBatch,
    cancelVideoBatchInputSchema,
    batchResult,
    (input, traceId) => service.cancelVideoBatch(input, traceId),
    (input) => `video.cancelVideoBatch:${JSON.stringify(input)}`,
  );

  registerQuery(
    VIDEO_IPC_CHANNELS.listVideoCandidates,
    listVideoCandidatesInputSchema,
    candidatesResult,
    (input, traceId) => service.listVideoCandidates(input, traceId),
  );
  registerQuery(
    VIDEO_IPC_CHANNELS.getVideoTask,
    getVideoTaskInputSchema,
    taskResult,
    (input, traceId) => service.getVideoTask(input, traceId),
  );
  registerQuery(
    VIDEO_IPC_CHANNELS.listStoryboardVideoStates,
    listStoryboardVideoStatesInputSchema,
    storyboardStatesResult,
    (input, traceId) => service.listStoryboardVideoStates(input, traceId),
  );
  registerQuery(
    VIDEO_IPC_CHANNELS.getTimeline,
    getVideoTimelineInputSchema,
    timelineResult,
    (input, traceId) => service.getTimeline(input, traceId),
  );
  registerQuery(
    VIDEO_IPC_CHANNELS.getExportJob,
    getVideoExportJobInputSchema,
    exportResult,
    (input, traceId) => service.getExportJob(input, traceId),
  );
  registerCommand(
    VIDEO_IPC_CHANNELS.createTimeline,
    createVideoTimelineInputSchema,
    timelineResult,
    (input, traceId) => service.createTimeline(input, traceId),
    (input) => `video.createTimeline:${JSON.stringify(input)}`,
  );
  registerCommand(
    VIDEO_IPC_CHANNELS.updateTimeline,
    updateVideoTimelineInputSchema,
    timelineResult,
    (input, traceId) => service.updateTimeline(input, traceId),
    (input) => `video.updateTimeline:${JSON.stringify(input)}`,
  );
  registerCommand(
    VIDEO_IPC_CHANNELS.importBackgroundMusic,
    importVideoBackgroundMusicInputSchema,
    audioResult,
    (input, traceId) => service.importBackgroundMusic(input, traceId),
    (input) => `video.importBackgroundMusic:${JSON.stringify(input)}`,
  );
  registerCommand(
    VIDEO_IPC_CHANNELS.startExport,
    startVideoExportInputSchema,
    exportResult,
    (input, traceId) => service.startExport(input, traceId),
    (input) => `video.startExport:${JSON.stringify(input)}`,
  );
  registerCommand(
    VIDEO_IPC_CHANNELS.cancelExport,
    cancelVideoExportInputSchema,
    exportResult,
    (input, traceId) => service.cancelExport(input, traceId),
    (input) => `video.cancelExport:${JSON.stringify(input)}`,
  );
};
