import type { ZodType } from 'zod';

import { isTrustedAppUrl } from '../security/window-policy';

export interface IpcFrame {
  readonly url: string;
}

export interface IpcEvent {
  readonly sender: { readonly mainFrame: IpcFrame };
  readonly senderFrame: IpcFrame | null;
}

/** Electron IPC 只接受当前受信主 frame；子 frame 与外部来源直接拒绝。 */
export const assertTrustedIpcSender = (event: IpcEvent, trustedUrl: string): void => {
  if (
    event.senderFrame === null ||
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedAppUrl(event.senderFrame.url, trustedUrl)
  ) {
    throw new Error('IPC_SENDER_NOT_ALLOWED');
  }
};

/** 固定逐方法 IPC 只接受一个严格 DTO，不提供可变参数命令面。 */
export const parseSingleIpcArgument = <T>(
  schema: ZodType<T>,
  arguments_: readonly unknown[],
): T | null => {
  if (arguments_.length !== 1) return null;
  const parsed = schema.safeParse(arguments_[0]);
  return parsed.success ? parsed.data : null;
};

export const hasNoIpcArguments = (arguments_: readonly unknown[]): boolean =>
  arguments_.length === 0;
