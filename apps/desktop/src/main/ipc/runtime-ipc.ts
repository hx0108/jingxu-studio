import type { StartupService } from '@jingxu/application';
import {
  restoreBackupCommandSchema,
  RUNTIME_IPC_CHANNELS,
  startupCommandSchema,
  startupStatusSchema,
} from '@jingxu/contracts';
import type { ZodType } from 'zod';

import { isTrustedAppUrl } from '../security/window-policy';

export { RUNTIME_IPC_CHANNELS };

export interface RuntimeIpcFrame {
  readonly url: string;
}

export interface RuntimeIpcEvent {
  readonly sender: { readonly mainFrame: RuntimeIpcFrame };
  readonly senderFrame: RuntimeIpcFrame | null;
}

export interface RuntimeIpcRegistrar {
  handle(
    channel: string,
    listener: (event: RuntimeIpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>,
  ): void;
}

const assertTrustedSender = (event: RuntimeIpcEvent, trustedUrl: string): void => {
  if (
    event.senderFrame === null ||
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedAppUrl(event.senderFrame.url, trustedUrl)
  ) {
    throw new Error('IPC_SENDER_NOT_ALLOWED');
  }
};

const parseSingleArgument = <T>(schema: ZodType<T>, arguments_: readonly unknown[]): T => {
  if (arguments_.length !== 1) throw new Error('IPC_INVALID_REQUEST');
  const parsed = schema.safeParse(arguments_[0]);
  if (!parsed.success) throw new Error('IPC_INVALID_REQUEST');
  return parsed.data;
};

/** Registers the fixed runtime IPC surface without exposing a generic channel API. */
export const registerRuntimeIpc = (
  registrar: RuntimeIpcRegistrar,
  startupService: StartupService,
  trustedUrl: string,
): void => {
  registrar.handle(RUNTIME_IPC_CHANNELS.getStartupStatus, (event, ...arguments_) => {
    assertTrustedSender(event, trustedUrl);
    if (arguments_.length !== 0) throw new Error('IPC_INVALID_REQUEST');
    return Promise.resolve(startupStatusSchema.parse(startupService.getStatus()));
  });
  registrar.handle(RUNTIME_IPC_CHANNELS.retryStartup, async (event, ...arguments_) => {
    assertTrustedSender(event, trustedUrl);
    const command = parseSingleArgument(startupCommandSchema, arguments_);
    return startupStatusSchema.parse(await startupService.retryStartup(command));
  });
  registrar.handle(RUNTIME_IPC_CHANNELS.restoreBackup, async (event, ...arguments_) => {
    assertTrustedSender(event, trustedUrl);
    const command = parseSingleArgument(restoreBackupCommandSchema, arguments_);
    return startupStatusSchema.parse(await startupService.restoreBackup(command));
  });
};
