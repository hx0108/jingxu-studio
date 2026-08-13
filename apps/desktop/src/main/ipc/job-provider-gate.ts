import {
  EVENTS_IPC_CHANNELS,
  JOB_IPC_CHANNELS,
  PROVIDER_IPC_CHANNELS,
  jobCreateInputSchema,
  jobGetInputSchema,
  jobListInputSchema,
  jobMutationInputSchema,
  jobUpdatesSubscriptionSchema,
  providerCredentialCommandSchema,
  providerGetInputSchema,
  providerMutationInputSchema,
  providerProfileCommandSchema,
} from '@jingxu/contracts';
import type { ZodType } from 'zod';

import { assertTrustedIpcSender, parseSingleIpcArgument, type IpcEvent } from './ipc-boundary';

export interface JobProviderIpcRegistrar {
  handle(
    channel: string,
    listener: (event: IpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>,
  ): void;
}
export interface StartupGate {
  isWriteReady(): boolean;
}
export interface JobProviderBoundaryService {
  invoke(channel: string, input: unknown): Promise<unknown>;
}

const writeChannels = new Set<string>([
  JOB_IPC_CHANNELS.create,
  JOB_IPC_CHANNELS.cancel,
  JOB_IPC_CHANNELS.retry,
  PROVIDER_IPC_CHANNELS.saveProfile,
  PROVIDER_IPC_CHANNELS.saveCredential,
  PROVIDER_IPC_CHANNELS.testCredential,
  PROVIDER_IPC_CHANNELS.deleteCredential,
]);
const schemas: Readonly<Record<string, ZodType>> = {
  [JOB_IPC_CHANNELS.create]: jobCreateInputSchema,
  [JOB_IPC_CHANNELS.get]: jobGetInputSchema,
  [JOB_IPC_CHANNELS.list]: jobListInputSchema,
  [JOB_IPC_CHANNELS.cancel]: jobMutationInputSchema,
  [JOB_IPC_CHANNELS.retry]: jobMutationInputSchema,
  [PROVIDER_IPC_CHANNELS.getProfile]: providerGetInputSchema,
  [PROVIDER_IPC_CHANNELS.saveProfile]: providerProfileCommandSchema,
  [PROVIDER_IPC_CHANNELS.saveCredential]: providerCredentialCommandSchema,
  [PROVIDER_IPC_CHANNELS.testCredential]: providerMutationInputSchema,
  [PROVIDER_IPC_CHANNELS.deleteCredential]: providerMutationInputSchema,
  [EVENTS_IPC_CHANNELS.subscribeJobUpdates]: jobUpdatesSubscriptionSchema,
};

const blocked = () => ({
  ok: false,
  error: {
    code: 'STARTUP_WRITE_BLOCKED',
    message: '应用尚未进入可写状态',
    retryable: true,
    userAction: '请先处理启动故障后重试',
    fieldErrors: null,
    traceId: 'trace_startup_gate',
  },
});
const invalid = () => ({
  ok: false,
  error: {
    code: 'IPC_INVALID_REQUEST',
    message: '请求参数无效',
    retryable: false,
    userAction: '请检查输入后重试',
    fieldErrors: null,
    traceId: 'trace_startup_gate',
  },
});

/** 仅负责固定频道、strict 输入与启动门；真实服务由后续 7.2/7.4 注入。 */
export const registerJobProviderGate = (
  registrar: JobProviderIpcRegistrar,
  gate: StartupGate,
  createService: () => JobProviderBoundaryService,
  trustedUrl: string,
): void => {
  let service: JobProviderBoundaryService | null = null;
  for (const [channel, schema] of Object.entries(schemas)) {
    registrar.handle(channel, (event, ...arguments_) => {
      assertTrustedIpcSender(event, trustedUrl);
      const input = parseSingleIpcArgument(schema, arguments_);
      if (input === null) return Promise.resolve(invalid());
      if (writeChannels.has(channel) && !gate.isWriteReady()) return Promise.resolve(blocked());
      service ??= createService();
      return service.invoke(channel, input);
    });
  }
};

export interface JobRecoveryPort {
  recover(): Promise<void>;
}
export class StartupJobRecoveryGate {
  readonly #createRecovery: () => JobRecoveryPort;
  readonly #gate: StartupGate;
  #started = false;
  public constructor(gate: StartupGate, createRecovery: () => JobRecoveryPort) {
    this.#gate = gate;
    this.#createRecovery = createRecovery;
  }
  public async activate(): Promise<boolean> {
    if (this.#started || !this.#gate.isWriteReady()) return false;
    this.#started = true;
    await this.#createRecovery().recover();
    return true;
  }
}
