import { randomUUID } from 'node:crypto';

import type {
  AppResultDto,
  CreatorDemoResultDto,
  CreatorNextActionResultDto,
  GetCreatorNextActionInputDto,
  StartCreatorDemoInputDto,
} from '@jingxu/contracts';
import {
  appResultSchema,
  CREATOR_GUIDE_IPC_CHANNELS,
  creatorDemoResultSchema,
  creatorNextActionResultSchema,
  getCreatorNextActionInputSchema,
  startCreatorDemoInputSchema,
} from '@jingxu/contracts';

import { assertTrustedIpcSender, parseSingleIpcArgument, type IpcEvent } from './ipc-boundary';

export { CREATOR_GUIDE_IPC_CHANNELS };
export type CreatorGuideIpcEvent = IpcEvent;

export interface CreatorGuideIpcRegistrar {
  handle(
    channel: string,
    listener: (event: CreatorGuideIpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>,
  ): void;
}

/** Main 注入的首页续作用例；IPC Host 不接触 Repository。 */
export interface CreatorGuideIpcService {
  getNextAction(
    input: GetCreatorNextActionInputDto,
    traceId: string,
  ): Promise<AppResultDto<CreatorNextActionResultDto>>;
  startDemo(
    input: StartCreatorDemoInputDto,
    traceId: string,
  ): Promise<AppResultDto<CreatorDemoResultDto>>;
}

export interface CreatorGuideIpcTraceIds {
  newTraceId(): string;
}

const invalidRequest = (traceId: string): AppResultDto<CreatorNextActionResultDto> => ({
  ok: false,
  error: {
    code: 'IPC_INVALID_REQUEST',
    fieldErrors: null,
    message: '请求参数无效',
    retryable: false,
    traceId,
    userAction: '请刷新后重试',
  },
});

const unavailable = (traceId: string): AppResultDto<CreatorNextActionResultDto> => ({
  ok: false,
  error: {
    code: 'PROJECT_PERSISTENCE_FAILED',
    fieldErrors: null,
    message: '暂时无法判断下一步',
    retryable: true,
    traceId,
    userAction: '请稍后重试',
  },
});

/** 注册只读的首页续作入口，并严格校验 sender、输入与输出。 */
export const registerCreatorGuideIpc = (
  registrar: CreatorGuideIpcRegistrar,
  service: CreatorGuideIpcService,
  trustedUrl: string,
  traceIds: CreatorGuideIpcTraceIds = { newTraceId: randomUUID },
): void => {
  registrar.handle(CREATOR_GUIDE_IPC_CHANNELS.getNextAction, async (event, ...arguments_) => {
    assertTrustedIpcSender(event, trustedUrl);
    const traceId = traceIds.newTraceId();
    const input = parseSingleIpcArgument(getCreatorNextActionInputSchema, arguments_);
    if (input === null) return invalidRequest(traceId);

    try {
      const parsed = appResultSchema(creatorNextActionResultSchema).safeParse(
        await service.getNextAction(input, traceId),
      );
      return parsed.success ? parsed.data : unavailable(traceId);
    } catch {
      return unavailable(traceId);
    }
  });

  registrar.handle(CREATOR_GUIDE_IPC_CHANNELS.startDemo, async (event, ...arguments_) => {
    assertTrustedIpcSender(event, trustedUrl);
    const traceId = traceIds.newTraceId();
    const input = parseSingleIpcArgument(startCreatorDemoInputSchema, arguments_);
    if (input === null) return invalidRequest(traceId);

    try {
      const parsed = appResultSchema(creatorDemoResultSchema).safeParse(
        await service.startDemo(input, traceId),
      );
      return parsed.success ? parsed.data : unavailable(traceId);
    } catch {
      return unavailable(traceId);
    }
  });
};
