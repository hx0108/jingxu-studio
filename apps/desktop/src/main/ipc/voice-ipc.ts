import { randomUUID } from 'node:crypto';

import {
  appResultSchema,
  deleteVoiceCandidateInputSchema,
  generateVoiceForEpisodeInputSchema,
  getVoiceGenerationsInputSchema,
  getVoiceMappingsInputSchema,
  saveVoiceMappingInputSchema,
  selectVoiceCandidateInputSchema,
  voiceCandidateDeleteResultSchema,
  voiceCandidateViewSchema,
  voiceEpisodeBatchViewSchema,
  voiceMappingSchema,
  VOICE_IPC_CHANNELS,
} from '@jingxu/contracts';
import type {
  AppResultDto,
  DeleteVoiceCandidateInputDto,
  GenerateVoiceForEpisodeInputDto,
  GetVoiceGenerationsInputDto,
  GetVoiceMappingsInputDto,
  SaveVoiceMappingInputDto,
  SelectVoiceCandidateInputDto,
  VoiceCandidateViewDto,
  VoiceEpisodeBatchViewDto,
  VoiceMappingDto,
} from '@jingxu/contracts';
import { z, type ZodType } from 'zod';

import { assertTrustedIpcSender, parseSingleIpcArgument, type IpcEvent } from './ipc-boundary';

export { VOICE_IPC_CHANNELS };

export interface VoiceIpcRegistrar {
  handle(
    channel: string,
    listener: (event: IpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>,
  ): void;
}

/**
 * Main 注入的 Voice 用例（六方法白名单，design D6 冻结面）：取消不设通道——
 * 调度器取消仅用于应用关停（scheduler 内部方法），无用户级取消语义。
 */
export interface VoiceIpcService {
  readonly getMappings: (
    input: GetVoiceMappingsInputDto,
    traceId: string,
  ) => Promise<AppResultDto<VoiceMappingDto[]>>;
  readonly saveMapping: (
    input: SaveVoiceMappingInputDto,
    traceId: string,
  ) => Promise<AppResultDto<VoiceMappingDto[]>>;
  readonly generateForEpisode: (
    input: GenerateVoiceForEpisodeInputDto,
    traceId: string,
  ) => Promise<AppResultDto<VoiceEpisodeBatchViewDto>>;
  readonly getGenerations: (
    input: GetVoiceGenerationsInputDto,
    traceId: string,
  ) => Promise<AppResultDto<VoiceCandidateViewDto[]>>;
  readonly selectCandidate: (
    input: SelectVoiceCandidateInputDto,
    traceId: string,
  ) => Promise<AppResultDto<VoiceCandidateViewDto[]>>;
  readonly deleteCandidate: (
    input: DeleteVoiceCandidateInputDto,
    traceId: string,
  ) => Promise<AppResultDto<{ candidateId: string }>>;
}

export interface VoiceStartupWriteGate {
  isWriteReady(): boolean;
}

export interface VoiceIpcTraceIds {
  newTraceId(): string;
}

interface InFlightEntry<T> {
  readonly promise: Promise<T>;
  readonly signature: string;
}

/** 同 requestId 并发 singleflight：同签名复用同结果，异签名判 REQUEST_ID_REUSED。 */
class VoiceRequestCoordinator {
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
    PROJECT_PERSISTENCE_FAILED: ['配音操作失败', '请重试；若持续失败，请检查启动状态', true],
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
 * 注册六个固定 voice channel，并按 sender、DTO、启动门、Application、输出依次校验。
 * 六方法（含只读查询）全部受启动写门约束——故障态下配音面板统一不可用。
 */
export const registerVoiceIpc = (
  registrar: VoiceIpcRegistrar,
  service: VoiceIpcService,
  startupGate: VoiceStartupWriteGate,
  trustedUrl: string,
  traceIds: VoiceIpcTraceIds = { newTraceId: randomUUID },
): void => {
  const coordinator = new VoiceRequestCoordinator();
  const mappingsResult = appResultSchema(z.array(voiceMappingSchema));
  const candidatesResult = appResultSchema(z.array(voiceCandidateViewSchema));
  const batchResult = appResultSchema(voiceEpisodeBatchViewSchema);
  const deleteResult = appResultSchema(voiceCandidateDeleteResultSchema);

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

  registerQuery(
    VOICE_IPC_CHANNELS.getMappings,
    getVoiceMappingsInputSchema,
    mappingsResult,
    (input, traceId) => service.getMappings(input, traceId),
  );
  registerQuery(
    VOICE_IPC_CHANNELS.getGenerations,
    getVoiceGenerationsInputSchema,
    candidatesResult,
    (input, traceId) => service.getGenerations(input, traceId),
  );
  registerCommand(
    VOICE_IPC_CHANNELS.saveMapping,
    saveVoiceMappingInputSchema,
    mappingsResult,
    (input, traceId) => service.saveMapping(input, traceId),
    (input) => `voice.saveMapping:${JSON.stringify(input)}`,
  );
  registerCommand(
    VOICE_IPC_CHANNELS.generateForEpisode,
    generateVoiceForEpisodeInputSchema,
    batchResult,
    (input, traceId) => service.generateForEpisode(input, traceId),
    (input) => `voice.generateForEpisode:${JSON.stringify(input)}`,
  );
  registerCommand(
    VOICE_IPC_CHANNELS.selectCandidate,
    selectVoiceCandidateInputSchema,
    candidatesResult,
    (input, traceId) => service.selectCandidate(input, traceId),
    (input) => `voice.selectCandidate:${JSON.stringify(input)}`,
  );
  registerCommand(
    VOICE_IPC_CHANNELS.deleteCandidate,
    deleteVoiceCandidateInputSchema,
    deleteResult,
    (input, traceId) => service.deleteCandidate(input, traceId),
    (input) => `voice.deleteCandidate:${JSON.stringify(input)}`,
  );
};
