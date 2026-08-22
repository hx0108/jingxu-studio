import { randomUUID } from 'node:crypto';

import {
  appResultSchema,
  evaluationAddAnnotationInputSchema,
  evaluationAddAnnotationResultSchema,
  evaluationCreateFromEpisodeInputSchema,
  evaluationCreateFromEpisodeResultSchema,
  evaluationCreateSampleInputSchema,
  evaluationDeleteSampleInputSchema,
  evaluationDeleteSampleResultSchema,
  evaluationGetSampleInputSchema,
  evaluationImportBatchInputSchema,
  evaluationImportBatchResultSchema,
  evaluationListSamplesInputSchema,
  evaluationListSamplesResultSchema,
  evaluationSampleDetailSchema,
  evaluationSampleSummarySchema,
  EVALUATION_IPC_CHANNELS,
} from '@jingxu/contracts';
import type {
  AppResultDto,
  EvaluationAddAnnotationInputDto,
  EvaluationAddAnnotationResultDto,
  EvaluationCreateFromEpisodeInputDto,
  EvaluationCreateFromEpisodeResultDto,
  EvaluationCreateSampleInputDto,
  EvaluationDeleteSampleInputDto,
  EvaluationDeleteSampleResultDto,
  EvaluationGetSampleInputDto,
  EvaluationImportBatchInputDto,
  EvaluationImportBatchResultDto,
  EvaluationListSamplesInputDto,
  EvaluationListSamplesResultDto,
  EvaluationSampleDetailDto,
  EvaluationSampleSummaryDto,
} from '@jingxu/contracts';
import type { ZodType } from 'zod';

import { assertTrustedIpcSender, parseSingleIpcArgument, type IpcEvent } from './ipc-boundary';

export interface EvaluationIpcRegistrar {
  handle(
    channel: string,
    listener: (event: IpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>,
  ): void;
}

/** Main 注入的 Evaluation Application 用例；IPC Host 不接触 Repository 或数据库连接。 */
export interface EvaluationIpcService {
  readonly listSamples: (
    input: EvaluationListSamplesInputDto,
    traceId: string,
  ) => Promise<AppResultDto<EvaluationListSamplesResultDto>>;
  readonly getSample: (
    input: EvaluationGetSampleInputDto,
    traceId: string,
  ) => Promise<AppResultDto<EvaluationSampleDetailDto>>;
  readonly createSample: (
    input: EvaluationCreateSampleInputDto,
    traceId: string,
  ) => Promise<AppResultDto<EvaluationSampleSummaryDto>>;
  readonly createFromEpisode: (
    input: EvaluationCreateFromEpisodeInputDto,
    traceId: string,
  ) => Promise<AppResultDto<EvaluationCreateFromEpisodeResultDto>>;
  readonly importBatch: (
    input: EvaluationImportBatchInputDto,
    traceId: string,
  ) => Promise<AppResultDto<EvaluationImportBatchResultDto>>;
  readonly deleteSample: (
    input: EvaluationDeleteSampleInputDto,
    traceId: string,
  ) => Promise<AppResultDto<EvaluationDeleteSampleResultDto>>;
  readonly addAnnotation: (
    input: EvaluationAddAnnotationInputDto,
    traceId: string,
  ) => Promise<AppResultDto<EvaluationAddAnnotationResultDto>>;
}

export interface EvaluationStartupGate {
  isWriteReady(): boolean;
}

interface InFlightEntry {
  readonly promise: Promise<unknown>;
  readonly signature: string;
}

/** requestId 写命令 singleflight：同 requestId 同载荷复用在途回执，异载荷拒绝。 */
class EvaluationRequestCoordinator {
  readonly #inFlight = new Map<string, InFlightEntry>();

  public run(
    requestId: string,
    signature: string,
    operation: () => Promise<unknown>,
    conflict: () => unknown,
  ): Promise<unknown> {
    const found = this.#inFlight.get(requestId);
    if (found !== undefined) {
      return found.signature === signature ? found.promise : Promise.resolve(conflict());
    }
    const promise = Promise.resolve().then(operation);
    const entry: InFlightEntry = { promise, signature };
    this.#inFlight.set(requestId, entry);
    const cleanup = (): void => {
      if (this.#inFlight.get(requestId) === entry) this.#inFlight.delete(requestId);
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }
}

const errorResult = (
  code:
    | 'IPC_INVALID_REQUEST'
    | 'PROJECT_PERSISTENCE_FAILED'
    | 'REQUEST_ID_REUSED'
    | 'STARTUP_WRITE_BLOCKED',
  traceId: string,
): AppResultDto<never> => {
  const messages = {
    IPC_INVALID_REQUEST: ['请求参数无效', '请检查输入后重试', false],
    PROJECT_PERSISTENCE_FAILED: ['评测集操作失败', '请重试；若持续失败，请检查启动状态', true],
    REQUEST_ID_REUSED: ['请求 ID 已用于其他操作', '请刷新后重新提交', false],
    STARTUP_WRITE_BLOCKED: ['应用尚未进入可写状态', '请先处理启动故障后重试', true],
  } as const;
  const [message, userAction, retryable] = messages[code];
  return {
    error: { code, fieldErrors: null, message, retryable, traceId, userAction },
    ok: false,
  };
};

/** 输出脱敏复验：Service throw 或畸形输出统一收敛为稳定错误码，零原文泄漏。 */
const parseOutput = async <T>(
  schema: ZodType<AppResultDto<T>>,
  operation: () => Promise<AppResultDto<T>>,
  traceId: string,
): Promise<AppResultDto<T>> => {
  try {
    const parsed = schema.safeParse(await operation());
    return parsed.success ? parsed.data : errorResult('PROJECT_PERSISTENCE_FAILED', traceId);
  } catch {
    return errorResult('PROJECT_PERSISTENCE_FAILED', traceId);
  }
};

/**
 * 注册七个固定 evaluation channel：sender → strict DTO → READY 门 →（requestId 写命令）
 * singleflight → Application → 输出脱敏复验。createSample 无 requestId（design.md
 * 幂等拍板）：并发重放由 dedup_key 唯一约束兜底，不参与协调器。
 */
export const registerEvaluationIpc = (
  registrar: EvaluationIpcRegistrar,
  service: EvaluationIpcService,
  gate: EvaluationStartupGate,
  trustedUrl: string,
  newTraceId: () => string = randomUUID,
): void => {
  const coordinator = new EvaluationRequestCoordinator();

  const registerChannel = <TInput, TOutput>(
    channel: string,
    inputSchema: ZodType<TInput>,
    outputSchema: ZodType<AppResultDto<TOutput>>,
    invoke: (input: TInput, traceId: string) => Promise<AppResultDto<TOutput>>,
    singleflightKey: (input: TInput) => string | null,
  ): void => {
    registrar.handle(channel, async (event, ...arguments_) => {
      assertTrustedIpcSender(event, trustedUrl);
      const traceId = newTraceId();
      const input = parseSingleIpcArgument(inputSchema, arguments_);
      if (input === null) return errorResult('IPC_INVALID_REQUEST', traceId);
      if (!gate.isWriteReady()) return errorResult('STARTUP_WRITE_BLOCKED', traceId);
      const requestId = singleflightKey(input);
      if (requestId === null) {
        return parseOutput(outputSchema, () => invoke(input, traceId), traceId);
      }
      const signature = `${channel}:${JSON.stringify(input)}`;
      return coordinator.run(
        requestId,
        signature,
        () => parseOutput(outputSchema, () => invoke(input, traceId), traceId),
        () => errorResult('REQUEST_ID_REUSED', traceId),
      );
    });
  };

  registerChannel(
    EVALUATION_IPC_CHANNELS.listSamples,
    evaluationListSamplesInputSchema,
    appResultSchema(evaluationListSamplesResultSchema),
    (input, traceId) => service.listSamples(input, traceId),
    () => null,
  );
  registerChannel(
    EVALUATION_IPC_CHANNELS.getSample,
    evaluationGetSampleInputSchema,
    appResultSchema(evaluationSampleDetailSchema),
    (input, traceId) => service.getSample(input, traceId),
    () => null,
  );
  registerChannel(
    EVALUATION_IPC_CHANNELS.createSample,
    evaluationCreateSampleInputSchema,
    appResultSchema(evaluationSampleSummarySchema),
    (input, traceId) => service.createSample(input, traceId),
    () => null,
  );
  registerChannel(
    EVALUATION_IPC_CHANNELS.createFromEpisode,
    evaluationCreateFromEpisodeInputSchema,
    appResultSchema(evaluationCreateFromEpisodeResultSchema),
    (input, traceId) => service.createFromEpisode(input, traceId),
    (input) => input.requestId,
  );
  registerChannel(
    EVALUATION_IPC_CHANNELS.importBatch,
    evaluationImportBatchInputSchema,
    appResultSchema(evaluationImportBatchResultSchema),
    (input, traceId) => service.importBatch(input, traceId),
    (input) => input.requestId,
  );
  registerChannel(
    EVALUATION_IPC_CHANNELS.deleteSample,
    evaluationDeleteSampleInputSchema,
    appResultSchema(evaluationDeleteSampleResultSchema),
    (input, traceId) => service.deleteSample(input, traceId),
    (input) => input.requestId,
  );
  registerChannel(
    EVALUATION_IPC_CHANNELS.addAnnotation,
    evaluationAddAnnotationInputSchema,
    appResultSchema(evaluationAddAnnotationResultSchema),
    (input, traceId) => service.addAnnotation(input, traceId),
    (input) => input.requestId,
  );
};
