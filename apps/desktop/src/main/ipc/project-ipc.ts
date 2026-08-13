import { randomUUID } from 'node:crypto';

import type {
  AppResultDto,
  CreateProjectInputDto,
  DeleteProjectInputDto,
  ProjectDetailDto,
  ProjectGetInputDto,
  ProjectListInputDto,
  ProjectListResultDto,
  RestoreProjectInputDto,
  UpdateProjectInputDto,
} from '@jingxu/contracts';
import {
  appResultSchema,
  createProjectInputSchema,
  deleteProjectInputSchema,
  PROJECT_IPC_CHANNELS,
  projectDetailSchema,
  projectGetInputSchema,
  projectListInputSchema,
  projectListResultSchema,
  restoreProjectInputSchema,
  updateProjectInputSchema,
} from '@jingxu/contracts';
import type { ZodType } from 'zod';

import { assertTrustedIpcSender, parseSingleIpcArgument, type IpcEvent } from './ipc-boundary';

export { PROJECT_IPC_CHANNELS };
export type ProjectIpcEvent = IpcEvent;

export interface ProjectIpcRegistrar {
  handle(
    channel: string,
    listener: (event: ProjectIpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>,
  ): void;
}

/** Main 注入的 Application 用例表面；不向 IPC Host 暴露 Repository 或连接。 */
export interface ProjectIpcService {
  list(input: ProjectListInputDto, traceId: string): Promise<AppResultDto<ProjectListResultDto>>;
  get(input: ProjectGetInputDto, traceId: string): Promise<AppResultDto<ProjectDetailDto>>;
  create(input: CreateProjectInputDto, traceId: string): Promise<AppResultDto<ProjectDetailDto>>;
  update(input: UpdateProjectInputDto, traceId: string): Promise<AppResultDto<ProjectDetailDto>>;
  delete(input: DeleteProjectInputDto, traceId: string): Promise<AppResultDto<ProjectDetailDto>>;
  restore(input: RestoreProjectInputDto, traceId: string): Promise<AppResultDto<ProjectDetailDto>>;
}

export interface ProjectStartupWriteGate {
  /** 只有启动自检处于 READY 且写入已启用时返回 true。 */
  isWriteReady(): boolean;
}

export interface ProjectIpcTraceIds {
  newTraceId(): string;
}

interface InFlightEntry<T> {
  readonly signature: string;
  readonly promise: Promise<T>;
}

/**
 * 同进程 requestId singleflight。跨进程/响应丢失仍由 SQLite receipt 负责；这里仅
 * 避免同时到达的相同命令重复进入 Application。
 */
class ProjectRequestCoordinator {
  readonly #inFlight = new Map<string, InFlightEntry<unknown>>();

  public run<T>(
    requestId: string,
    signature: string,
    operation: () => Promise<T>,
    conflict: () => T,
  ): Promise<T> {
    const found = this.#inFlight.get(requestId);
    if (found !== undefined) {
      if (found.signature !== signature) return Promise.resolve(conflict());
      return found.promise as Promise<T>;
    }

    const promise = Promise.resolve().then(operation);
    const entry: InFlightEntry<T> = { signature, promise };
    this.#inFlight.set(requestId, entry);
    const cleanup = (): void => {
      if (this.#inFlight.get(requestId) === entry) this.#inFlight.delete(requestId);
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }
}

const invalidRequest = <T>(traceId: string): AppResultDto<T> => ({
  ok: false,
  error: {
    code: 'IPC_INVALID_REQUEST',
    message: '请求参数无效',
    retryable: false,
    userAction: '请检查输入后重试',
    fieldErrors: null,
    traceId,
  },
});

const writeBlocked = <T>(traceId: string): AppResultDto<T> => ({
  ok: false,
  error: {
    code: 'STARTUP_WRITE_BLOCKED',
    message: '应用尚未进入可写状态',
    retryable: true,
    userAction: '请先处理启动故障后重试',
    fieldErrors: null,
    traceId,
  },
});

const requestIdReused = <T>(traceId: string): AppResultDto<T> => ({
  ok: false,
  error: {
    code: 'REQUEST_ID_REUSED',
    message: '请求 ID 已用于其他操作',
    retryable: false,
    userAction: '请刷新后重新提交',
    fieldErrors: null,
    traceId,
  },
});

const persistenceFailed = <T>(traceId: string): AppResultDto<T> => ({
  ok: false,
  error: {
    code: 'PROJECT_PERSISTENCE_FAILED',
    message: '项目操作失败，请重试',
    retryable: true,
    userAction: '请重试；若持续失败，请返回启动故障页检查状态',
    fieldErrors: null,
    traceId,
  },
});

const parseServiceResult = async <T>(
  outputSchema: ZodType<AppResultDto<T>>,
  operation: () => Promise<AppResultDto<T>>,
  traceId: string,
): Promise<AppResultDto<T>> => {
  try {
    const parsed = outputSchema.safeParse(await operation());
    return parsed.success ? parsed.data : persistenceFailed(traceId);
  } catch {
    return persistenceFailed(traceId);
  }
};

const createResultSchema = appResultSchema(projectDetailSchema);
const listResultSchema = appResultSchema(projectListResultSchema);

/** Registers the six fixed Project channels with sender, DTO, write-gate and output checks. */
export const registerProjectIpc = (
  registrar: ProjectIpcRegistrar,
  service: ProjectIpcService,
  startupGate: ProjectStartupWriteGate,
  trustedUrl: string,
  traceIds: ProjectIpcTraceIds = { newTraceId: randomUUID },
): void => {
  const coordinator = new ProjectRequestCoordinator();

  registrar.handle(PROJECT_IPC_CHANNELS.list, (event, ...arguments_) => {
    assertTrustedIpcSender(event, trustedUrl);
    const traceId = traceIds.newTraceId();
    const input = parseSingleIpcArgument(projectListInputSchema, arguments_);
    if (input === null) return Promise.resolve(invalidRequest(traceId));
    return parseServiceResult(listResultSchema, () => service.list(input, traceId), traceId);
  });

  registrar.handle(PROJECT_IPC_CHANNELS.get, (event, ...arguments_) => {
    assertTrustedIpcSender(event, trustedUrl);
    const traceId = traceIds.newTraceId();
    const input = parseSingleIpcArgument(projectGetInputSchema, arguments_);
    if (input === null) return Promise.resolve(invalidRequest(traceId));
    return parseServiceResult(createResultSchema, () => service.get(input, traceId), traceId);
  });

  const registerCommand = <TInput extends { readonly requestId: string }>(
    channel: string,
    inputSchema: ZodType<TInput>,
    invoke: (input: TInput, traceId: string) => Promise<AppResultDto<ProjectDetailDto>>,
  ): void => {
    registrar.handle(channel, (event, ...arguments_) => {
      assertTrustedIpcSender(event, trustedUrl);
      const traceId = traceIds.newTraceId();
      const input = parseSingleIpcArgument(inputSchema, arguments_);
      if (input === null) return Promise.resolve(invalidRequest(traceId));
      if (!startupGate.isWriteReady()) return Promise.resolve(writeBlocked(traceId));

      const signature = `${channel}:${JSON.stringify(input)}`;
      return coordinator.run(
        input.requestId,
        signature,
        () => parseServiceResult(createResultSchema, () => invoke(input, traceId), traceId),
        () => requestIdReused(traceId),
      );
    });
  };

  registerCommand(PROJECT_IPC_CHANNELS.create, createProjectInputSchema, (input, traceId) =>
    service.create(input, traceId),
  );
  registerCommand(PROJECT_IPC_CHANNELS.update, updateProjectInputSchema, (input, traceId) =>
    service.update(input, traceId),
  );
  registerCommand(PROJECT_IPC_CHANNELS.delete, deleteProjectInputSchema, (input, traceId) =>
    service.delete(input, traceId),
  );
  registerCommand(PROJECT_IPC_CHANNELS.restore, restoreProjectInputSchema, (input, traceId) =>
    service.restore(input, traceId),
  );
};
