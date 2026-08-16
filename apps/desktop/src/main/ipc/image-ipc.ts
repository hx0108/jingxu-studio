import { createHash, randomUUID } from 'node:crypto';

import {
  appResultSchema,
  assetViewSchema,
  generateCandidatesInputSchema,
  getMediaTaskInputSchema,
  IMAGE_IPC_CHANNELS,
  imageCandidateViewSchema,
  listAssetsInputSchema,
  listCandidatesInputSchema,
  mediaTaskViewSchema,
  selectCandidateInputSchema,
  uploadAssetReferenceInputSchema,
  uploadAssetReferenceResultSchema,
} from '@jingxu/contracts';
import type {
  AppResultDto,
  AssetViewDto,
  GenerateCandidatesInputDto,
  GetMediaTaskInputDto,
  ImageCandidateViewDto,
  ListAssetsInputDto,
  ListCandidatesInputDto,
  MediaTaskViewDto,
  SelectCandidateInputDto,
  UploadAssetReferenceInputDto,
  UploadAssetReferenceResultDto,
} from '@jingxu/contracts';
import { z, type ZodType } from 'zod';

import { assertTrustedIpcSender, parseSingleIpcArgument, type IpcEvent } from './ipc-boundary';

export { IMAGE_IPC_CHANNELS };

export interface ImageIpcRegistrar {
  handle(
    channel: string,
    listener: (event: IpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>,
  ): void;
}

/** Main 注入的 Image 用例（六方法白名单）；IPC Host 不接触 Repository、字节存储或 SQL。 */
export interface ImageIpcService {
  readonly generateCandidates: (
    input: GenerateCandidatesInputDto,
    traceId: string,
  ) => Promise<AppResultDto<MediaTaskViewDto>>;
  readonly listCandidates: (
    input: ListCandidatesInputDto,
    traceId: string,
  ) => Promise<AppResultDto<ImageCandidateViewDto[]>>;
  readonly selectCandidate: (
    input: SelectCandidateInputDto,
    traceId: string,
  ) => Promise<AppResultDto<ImageCandidateViewDto[]>>;
  readonly listAssets: (
    input: ListAssetsInputDto,
    traceId: string,
  ) => Promise<AppResultDto<AssetViewDto[]>>;
  readonly uploadAssetReference: (
    input: UploadAssetReferenceInputDto,
    traceId: string,
  ) => Promise<AppResultDto<UploadAssetReferenceResultDto>>;
  readonly getMediaTask: (
    input: GetMediaTaskInputDto,
    traceId: string,
  ) => Promise<AppResultDto<MediaTaskViewDto>>;
}

export interface ImageStartupWriteGate {
  isWriteReady(): boolean;
}

export interface ImageIpcTraceIds {
  newTraceId(): string;
}

interface InFlightEntry<T> {
  readonly promise: Promise<T>;
  readonly signature: string;
}

/** 同 requestId 并发 singleflight：同签名复用同结果，异签名判 REQUEST_ID_REUSED。 */
class ImageRequestCoordinator {
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
    PROJECT_PERSISTENCE_FAILED: ['图片操作失败', '请重试；若持续失败，请检查启动状态', true],
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
 * 注册六个固定 image channel，并按 sender、DTO、启动门、Application、输出依次校验。
 * 六方法（含只读查询）全部受启动写门约束——故障态下媒体面板统一不可用。
 */
export const registerImageIpc = (
  registrar: ImageIpcRegistrar,
  service: ImageIpcService,
  startupGate: ImageStartupWriteGate,
  trustedUrl: string,
  traceIds: ImageIpcTraceIds = { newTraceId: randomUUID },
): void => {
  const coordinator = new ImageRequestCoordinator();
  const taskResult = appResultSchema(mediaTaskViewSchema);
  const candidatesResult = appResultSchema(z.array(imageCandidateViewSchema));
  const assetsResult = appResultSchema(z.array(assetViewSchema));
  const uploadResult = appResultSchema(uploadAssetReferenceResultSchema);

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
    IMAGE_IPC_CHANNELS.generateCandidates,
    generateCandidatesInputSchema,
    taskResult,
    (input, traceId) => service.generateCandidates(input, traceId),
    (input) => `image.generateCandidates:${JSON.stringify(input)}`,
  );
  registerCommand(
    IMAGE_IPC_CHANNELS.selectCandidate,
    selectCandidateInputSchema,
    candidatesResult,
    (input, traceId) => service.selectCandidate(input, traceId),
    (input) => `image.selectCandidate:${JSON.stringify(input)}`,
  );
  registerCommand(
    IMAGE_IPC_CHANNELS.uploadAssetReference,
    uploadAssetReferenceInputSchema,
    uploadResult,
    (input, traceId) => service.uploadAssetReference(input, traceId),
    // 签名不序列化字节（≤20MB Uint8Array 的 JSON 展开是内存炸弹）：哈希代替。
    (input) =>
      `image.uploadAssetReference:${createHash('sha256').update(input.bytes).digest('hex')}:${JSON.stringify({ ...input, bytes: undefined })}`,
  );

  registerQuery(
    IMAGE_IPC_CHANNELS.listCandidates,
    listCandidatesInputSchema,
    candidatesResult,
    (input, traceId) => service.listCandidates(input, traceId),
  );
  registerQuery(
    IMAGE_IPC_CHANNELS.listAssets,
    listAssetsInputSchema,
    assetsResult,
    (input, traceId) => service.listAssets(input, traceId),
  );
  registerQuery(IMAGE_IPC_CHANNELS.getTask, getMediaTaskInputSchema, taskResult, (input, traceId) =>
    service.getMediaTask(input, traceId),
  );
};
