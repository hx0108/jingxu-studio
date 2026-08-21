import { randomUUID } from 'node:crypto';

import {
  appResultSchema,
  TRANSFER_IPC_CHANNELS,
  transferExportProjectInputSchema,
  transferExportResultSchema,
  transferImportProjectInputSchema,
  transferImportResultSchema,
} from '@jingxu/contracts';
import type {
  AppResultDto,
  TransferExportProjectInputDto,
  TransferExportResultDto,
  TransferImportProjectInputDto,
  TransferImportResultDto,
} from '@jingxu/contracts';

import { assertTrustedIpcSender, type IpcEvent } from './ipc-boundary';

export interface TransferIpcRegistrar {
  handle(
    channel: string,
    listener: (event: IpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>,
  ): void;
}

export interface TransferIpcService {
  exportProject(
    input: TransferExportProjectInputDto,
    traceId: string,
  ): Promise<AppResultDto<TransferExportResultDto>>;
  importProject(
    input: TransferImportProjectInputDto,
    traceId: string,
  ): Promise<AppResultDto<TransferImportResultDto>>;
}

export interface TransferStartupGate {
  isWriteReady(): boolean;
}

const failure = <T>(
  code: 'IPC_INVALID_REQUEST' | 'STARTUP_WRITE_BLOCKED' | 'REQUEST_ID_REUSED',
  traceId: string,
): AppResultDto<T> => ({
  error: {
    code,
    fieldErrors: null,
    message:
      code === 'STARTUP_WRITE_BLOCKED'
        ? '应用尚未进入可写状态'
        : code === 'REQUEST_ID_REUSED'
          ? '请求标识已被其他操作使用'
          : '请求参数无效',
    retryable: code === 'STARTUP_WRITE_BLOCKED',
    traceId,
    userAction: '请检查输入和启动状态后重试',
  },
  ok: false,
});

export const registerTransferIpc = (
  registrar: TransferIpcRegistrar,
  service: TransferIpcService,
  gate: TransferStartupGate,
  trustedUrl: string,
  newTraceId: () => string = randomUUID,
): void => {
  const inFlight = new Map<string, { signature: string; promise: Promise<unknown> }>();
  const command = <TInput extends { readonly requestId: string }, TOutput>(
    channel: string,
    parse: (value: unknown) => TInput,
    invoke: (input: TInput, traceId: string) => Promise<AppResultDto<TOutput>>,
    output: ReturnType<typeof appResultSchema>,
  ): void => {
    registrar.handle(channel, async (event, ...arguments_) => {
      assertTrustedIpcSender(event, trustedUrl);
      const traceId = newTraceId();
      if (!gate.isWriteReady()) return failure<TOutput>('STARTUP_WRITE_BLOCKED', traceId);
      if (arguments_.length !== 1) return failure<TOutput>('IPC_INVALID_REQUEST', traceId);
      let input: TInput;
      try {
        input = parse(arguments_[0]);
      } catch {
        return failure<TOutput>('IPC_INVALID_REQUEST', traceId);
      }
      const signature = `${channel}:${JSON.stringify(input)}`;
      const existing = inFlight.get(input.requestId);
      if (existing !== undefined) {
        return existing.signature === signature
          ? existing.promise
          : failure<TOutput>('REQUEST_ID_REUSED', traceId);
      }
      const promise = invoke(input, traceId).then((result) => output.parse(result));
      inFlight.set(input.requestId, { promise, signature });
      void promise.finally(() => inFlight.delete(input.requestId));
      return promise;
    });
  };
  command(
    TRANSFER_IPC_CHANNELS.exportProject,
    (value) => transferExportProjectInputSchema.parse(value),
    (input, traceId) => service.exportProject(input, traceId),
    appResultSchema(transferExportResultSchema),
  );
  command(
    TRANSFER_IPC_CHANNELS.importProject,
    (value) => transferImportProjectInputSchema.parse(value),
    (input, traceId) => service.importProject(input, traceId),
    appResultSchema(transferImportResultSchema),
  );
};
