import type { StartupService } from '@jingxu/application';
import {
  restoreBackupCommandSchema,
  RUNTIME_IPC_CHANNELS,
  startupCommandSchema,
  startupStatusSchema,
} from '@jingxu/contracts';
import {
  assertTrustedIpcSender,
  hasNoIpcArguments,
  parseSingleIpcArgument,
  type IpcEvent,
} from './ipc-boundary';

export { RUNTIME_IPC_CHANNELS };

export type RuntimeIpcEvent = IpcEvent;

export interface RuntimeIpcRegistrar {
  handle(
    channel: string,
    listener: (event: RuntimeIpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>,
  ): void;
}

/** Registers the fixed runtime IPC surface without exposing a generic channel API. */
export const registerRuntimeIpc = (
  registrar: RuntimeIpcRegistrar,
  startupService: StartupService,
  trustedUrl: string,
): void => {
  registrar.handle(RUNTIME_IPC_CHANNELS.getStartupStatus, (event, ...arguments_) => {
    assertTrustedIpcSender(event, trustedUrl);
    if (!hasNoIpcArguments(arguments_)) throw new Error('IPC_INVALID_REQUEST');
    return Promise.resolve(startupStatusSchema.parse(startupService.getStatus()));
  });
  registrar.handle(RUNTIME_IPC_CHANNELS.retryStartup, async (event, ...arguments_) => {
    assertTrustedIpcSender(event, trustedUrl);
    const command = parseSingleIpcArgument(startupCommandSchema, arguments_);
    if (command === null) throw new Error('IPC_INVALID_REQUEST');
    return startupStatusSchema.parse(await startupService.retryStartup(command));
  });
  registrar.handle(RUNTIME_IPC_CHANNELS.restoreBackup, async (event, ...arguments_) => {
    assertTrustedIpcSender(event, trustedUrl);
    const command = parseSingleIpcArgument(restoreBackupCommandSchema, arguments_);
    if (command === null) throw new Error('IPC_INVALID_REQUEST');
    return startupStatusSchema.parse(await startupService.restoreBackup(command));
  });
};
