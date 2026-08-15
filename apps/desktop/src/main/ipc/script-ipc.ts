import { randomUUID } from 'node:crypto';

import {
  appResultSchema,
  confirmScriptVersionInputSchema,
  getScriptWorkspaceInputSchema,
  initializeOriginalInputSchema,
  restoreScriptVersionInputSchema,
  saveScriptDraftInputSchema,
  SCRIPT_IPC_CHANNELS,
  scriptMutationResultSchema,
  scriptVersionSchema,
  scriptWorkspaceSchema,
} from '@jingxu/contracts';
import type {
  AppResultDto,
  ConfirmScriptVersionInputDto,
  GetScriptWorkspaceInputDto,
  InitializeOriginalInputDto,
  RestoreScriptVersionInputDto,
  SaveScriptDraftInputDto,
  ScriptMutationResultDto,
  ScriptVersionDto,
  ScriptWorkspaceDto,
} from '@jingxu/contracts';
import type { ZodType } from 'zod';

import { assertTrustedIpcSender, parseSingleIpcArgument, type IpcEvent } from './ipc-boundary';

export { SCRIPT_IPC_CHANNELS };

export interface ScriptIpcRegistrar {
  handle(
    channel: string,
    listener: (event: IpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>,
  ): void;
}

/** Main 注入的 Script Application 用例；IPC Host 不接触 Repository 或数据库连接。 */
export interface ScriptIpcService {
  readonly initializeOriginal: (
    input: InitializeOriginalInputDto,
    traceId: string,
  ) => Promise<AppResultDto<ScriptWorkspaceDto>>;
  readonly getWorkspace: (
    input: GetScriptWorkspaceInputDto,
    traceId: string,
  ) => Promise<AppResultDto<ScriptWorkspaceDto>>;
  readonly saveDraft: (
    input: SaveScriptDraftInputDto,
    traceId: string,
  ) => Promise<AppResultDto<ScriptVersionDto>>;
  readonly confirmVersion: (
    input: ConfirmScriptVersionInputDto,
    traceId: string,
  ) => Promise<AppResultDto<ScriptMutationResultDto>>;
  readonly restoreVersion: (
    input: RestoreScriptVersionInputDto,
    traceId: string,
  ) => Promise<AppResultDto<ScriptMutationResultDto>>;
}

export interface ScriptStartupWriteGate {
  isWriteReady(): boolean;
}

export interface ScriptIpcTraceIds {
  newTraceId(): string;
}

interface InFlightEntry<T> {
  readonly promise: Promise<T>;
  readonly signature: string;
}

class ScriptRequestCoordinator {
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
    PROJECT_PERSISTENCE_FAILED: ['剧本操作失败', '请重试；若持续失败，请检查启动状态', true],
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

/** 注册五个固定 Script channel，并按 sender、DTO、启动门、Application、输出依次校验。 */
export const registerScriptIpc = (
  registrar: ScriptIpcRegistrar,
  service: ScriptIpcService,
  startupGate: ScriptStartupWriteGate,
  trustedUrl: string,
  traceIds: ScriptIpcTraceIds = { newTraceId: randomUUID },
): void => {
  const coordinator = new ScriptRequestCoordinator();
  const workspaceResult = appResultSchema(scriptWorkspaceSchema);
  const versionResult = appResultSchema(scriptVersionSchema);
  // 确认/恢复按 stage 分派：五阶段返回版本文档，SHOT_CONTRACT 返回整集摘要（D6）。
  const mutationResult = appResultSchema(scriptMutationResultSchema);

  registrar.handle(SCRIPT_IPC_CHANNELS.getWorkspace, (event, ...arguments_) => {
    assertTrustedIpcSender(event, trustedUrl);
    const traceId = traceIds.newTraceId();
    const input = parseSingleIpcArgument(getScriptWorkspaceInputSchema, arguments_);
    if (input === null) return Promise.resolve(errorResult('IPC_INVALID_REQUEST', traceId));
    return parseOutput(workspaceResult, () => service.getWorkspace(input, traceId), traceId);
  });

  const registerCommand = <TInput extends { readonly requestId: string }, TOutput>(
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
      const signature = `${channel}:${JSON.stringify(input)}`;
      return coordinator.run(
        input.requestId,
        signature,
        () => parseOutput(outputSchema, () => invoke(input, traceId), traceId),
        () => errorResult('REQUEST_ID_REUSED', traceId),
      );
    });
  };

  registerCommand(
    SCRIPT_IPC_CHANNELS.initializeOriginal,
    initializeOriginalInputSchema,
    workspaceResult,
    (input, traceId) => service.initializeOriginal(input, traceId),
  );
  registerCommand(
    SCRIPT_IPC_CHANNELS.saveDraft,
    saveScriptDraftInputSchema,
    versionResult,
    (input, traceId) => service.saveDraft(input, traceId),
  );
  registerCommand(
    SCRIPT_IPC_CHANNELS.confirmVersion,
    confirmScriptVersionInputSchema,
    mutationResult,
    (input, traceId) => service.confirmVersion(input, traceId),
  );
  registerCommand(
    SCRIPT_IPC_CHANNELS.restoreVersion,
    restoreScriptVersionInputSchema,
    mutationResult,
    (input, traceId) => service.restoreVersion(input, traceId),
  );
};
