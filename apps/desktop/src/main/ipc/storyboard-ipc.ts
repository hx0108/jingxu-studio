import { randomUUID } from 'node:crypto';

import {
  appResultSchema,
  STORYBOARD_IPC_CHANNELS,
  shotEditLockSummarySchema,
  storyboardEditShotInputSchema,
  storyboardExportEpisodeInputSchema,
  storyboardExportResultSchema,
  storyboardLockShotInputSchema,
  storyboardUnlockShotInputSchema,
  storyboardSplitShotInputSchema,
  storyboardMergeShotsInputSchema,
  storyboardCopyShotInputSchema,
  storyboardReorderShotsInputSchema,
  storyboardDeleteShotInputSchema,
  storyboardRestoreShotInputSchema,
} from '@jingxu/contracts';
import type {
  AppResultDto,
  ShotEditLockSummaryDto,
  StoryboardEditShotInputDto,
  StoryboardExportEpisodeInputDto,
  StoryboardExportResultDto,
  StoryboardLockShotInputDto,
  StoryboardUnlockShotInputDto,
  StoryboardSplitShotInputDto,
  StoryboardMergeShotsInputDto,
  StoryboardCopyShotInputDto,
  StoryboardReorderShotsInputDto,
  StoryboardDeleteShotInputDto,
  StoryboardRestoreShotInputDto,
} from '@jingxu/contracts';
import type { ZodType } from 'zod';

import { assertTrustedIpcSender, parseSingleIpcArgument, type IpcEvent } from './ipc-boundary';

export { STORYBOARD_IPC_CHANNELS };

export interface StoryboardIpcRegistrar {
  handle(
    channel: string,
    listener: (event: IpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>,
  ): void;
}

/** Main 注入的分镜编辑/锁定/导出用例；IPC Host 不接触 Repository 或数据库连接。 */
export interface StoryboardIpcService {
  readonly editShot: (
    input: StoryboardEditShotInputDto,
    traceId: string,
  ) => Promise<AppResultDto<ShotEditLockSummaryDto>>;
  readonly exportEpisode: (
    input: StoryboardExportEpisodeInputDto,
    traceId: string,
  ) => Promise<AppResultDto<StoryboardExportResultDto>>;
  readonly lockShot: (
    input: StoryboardLockShotInputDto,
    traceId: string,
  ) => Promise<AppResultDto<ShotEditLockSummaryDto>>;
  readonly unlockShot: (
    input: StoryboardUnlockShotInputDto,
    traceId: string,
  ) => Promise<AppResultDto<ShotEditLockSummaryDto>>;
  readonly splitShot?: (
    input: StoryboardSplitShotInputDto,
    traceId: string,
  ) => Promise<AppResultDto<ShotEditLockSummaryDto>>;
  readonly mergeShots?: (
    input: StoryboardMergeShotsInputDto,
    traceId: string,
  ) => Promise<AppResultDto<ShotEditLockSummaryDto>>;
  readonly copyShot?: (
    input: StoryboardCopyShotInputDto,
    traceId: string,
  ) => Promise<AppResultDto<ShotEditLockSummaryDto>>;
  readonly reorderShots?: (
    input: StoryboardReorderShotsInputDto,
    traceId: string,
  ) => Promise<AppResultDto<ShotEditLockSummaryDto>>;
  readonly deleteShot?: (
    input: StoryboardDeleteShotInputDto,
    traceId: string,
  ) => Promise<AppResultDto<ShotEditLockSummaryDto>>;
  readonly restoreShot?: (
    input: StoryboardRestoreShotInputDto,
    traceId: string,
  ) => Promise<AppResultDto<ShotEditLockSummaryDto>>;
}

export interface StoryboardStartupWriteGate {
  isWriteReady(): boolean;
}

export interface StoryboardIpcTraceIds {
  newTraceId(): string;
}

interface InFlightEntry<T> {
  readonly promise: Promise<T>;
  readonly signature: string;
}

class StoryboardRequestCoordinator {
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
    PROJECT_PERSISTENCE_FAILED: ['分镜操作失败', '请重试；若持续失败，请检查启动状态', true],
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

/** 注册四个 storyboard.* 命令 channel，并按 sender、DTO、启动门、Application、输出依次校验。 */
export const registerStoryboardIpc = (
  registrar: StoryboardIpcRegistrar,
  service: StoryboardIpcService,
  startupGate: StoryboardStartupWriteGate,
  trustedUrl: string,
  traceIds: StoryboardIpcTraceIds = { newTraceId: randomUUID },
): void => {
  const coordinator = new StoryboardRequestCoordinator();

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

  const summaryResult = appResultSchema(shotEditLockSummarySchema);
  registerCommand(
    STORYBOARD_IPC_CHANNELS.editShot,
    storyboardEditShotInputSchema,
    summaryResult,
    (input, traceId) => service.editShot(input, traceId),
  );
  registerCommand(
    STORYBOARD_IPC_CHANNELS.exportEpisode,
    storyboardExportEpisodeInputSchema,
    appResultSchema(storyboardExportResultSchema),
    (input, traceId) => service.exportEpisode(input, traceId),
  );
  registerCommand(
    STORYBOARD_IPC_CHANNELS.lockShot,
    storyboardLockShotInputSchema,
    summaryResult,
    (input, traceId) => service.lockShot(input, traceId),
  );
  registerCommand(
    STORYBOARD_IPC_CHANNELS.unlockShot,
    storyboardUnlockShotInputSchema,
    summaryResult,
    (input, traceId) => service.unlockShot(input, traceId),
  );
  registerCommand(
    STORYBOARD_IPC_CHANNELS.splitShot,
    storyboardSplitShotInputSchema,
    summaryResult,
    (input, traceId) =>
      service.splitShot?.(input, traceId) ??
      Promise.resolve(errorResult('PROJECT_PERSISTENCE_FAILED', traceId)),
  );
  registerCommand(
    STORYBOARD_IPC_CHANNELS.mergeShots,
    storyboardMergeShotsInputSchema,
    summaryResult,
    (input, traceId) =>
      service.mergeShots?.(input, traceId) ??
      Promise.resolve(errorResult('PROJECT_PERSISTENCE_FAILED', traceId)),
  );
  registerCommand(
    STORYBOARD_IPC_CHANNELS.copyShot,
    storyboardCopyShotInputSchema,
    summaryResult,
    (input, traceId) =>
      service.copyShot?.(input, traceId) ??
      Promise.resolve(errorResult('PROJECT_PERSISTENCE_FAILED', traceId)),
  );
  registerCommand(
    STORYBOARD_IPC_CHANNELS.reorderShots,
    storyboardReorderShotsInputSchema,
    summaryResult,
    (input, traceId) =>
      service.reorderShots?.(input, traceId) ??
      Promise.resolve(errorResult('PROJECT_PERSISTENCE_FAILED', traceId)),
  );
  registerCommand(
    STORYBOARD_IPC_CHANNELS.deleteShot,
    storyboardDeleteShotInputSchema,
    summaryResult,
    (input, traceId) =>
      service.deleteShot?.(input, traceId) ??
      Promise.resolve(errorResult('PROJECT_PERSISTENCE_FAILED', traceId)),
  );
  registerCommand(
    STORYBOARD_IPC_CHANNELS.restoreShot,
    storyboardRestoreShotInputSchema,
    summaryResult,
    (input, traceId) =>
      service.restoreShot?.(input, traceId) ??
      Promise.resolve(errorResult('PROJECT_PERSISTENCE_FAILED', traceId)),
  );
};
