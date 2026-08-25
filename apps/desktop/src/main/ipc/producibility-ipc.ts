import { randomUUID } from 'node:crypto';
import {
  appResultSchema,
  PRODUCIBILITY_IPC_CHANNELS,
  producibilityGetReportInputSchema,
  producibilityOverrideFindingInputSchema,
  producibilityReportSchema,
  producibilityRunInputSchema,
} from '@jingxu/contracts';
import type {
  AppResultDto,
  ProducibilityGetReportInputDto,
  ProducibilityOverrideFindingInputDto,
  ProducibilityReportDto,
  ProducibilityRunInputDto,
} from '@jingxu/contracts';
import type { ZodType } from 'zod';
import { assertTrustedIpcSender, parseSingleIpcArgument, type IpcEvent } from './ipc-boundary';

export interface ProducibilityIpcRegistrar {
  handle(
    channel: string,
    listener: (event: IpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>,
  ): void;
}
export interface ProducibilityIpcService {
  run(
    input: ProducibilityRunInputDto,
    traceId: string,
  ): Promise<AppResultDto<ProducibilityReportDto>>;
  getReport(
    input: ProducibilityGetReportInputDto,
    traceId: string,
  ): Promise<AppResultDto<ProducibilityReportDto>>;
  overrideFinding(
    input: ProducibilityOverrideFindingInputDto,
    traceId: string,
  ): Promise<AppResultDto<ProducibilityReportDto>>;
}
const failure = <T>(traceId: string): AppResultDto<T> => ({
  ok: false,
  error: {
    code: 'PROJECT_PERSISTENCE_FAILED',
    fieldErrors: null,
    message: '可生产性报告操作失败',
    retryable: true,
    traceId,
    userAction: '请重试。',
  },
});
export const registerProducibilityIpc = (
  registrar: ProducibilityIpcRegistrar,
  service: ProducibilityIpcService,
  trustedUrl: string,
): void => {
  const register = <T>(
    channel: string,
    schema: ZodType<T>,
    invoke: (input: T, traceId: string) => Promise<AppResultDto<ProducibilityReportDto>>,
  ): void => {
    registrar.handle(channel, async (event, ...args) => {
      assertTrustedIpcSender(event, trustedUrl);
      const traceId = randomUUID();
      const input = parseSingleIpcArgument(schema, args);
      if (input === null) return failure(traceId);
      try {
        return appResultSchema(producibilityReportSchema).parse(await invoke(input, traceId));
      } catch {
        return failure(traceId);
      }
    });
  };
  register(PRODUCIBILITY_IPC_CHANNELS.run, producibilityRunInputSchema, (input, traceId) =>
    service.run(input, traceId),
  );
  register(
    PRODUCIBILITY_IPC_CHANNELS.getReport,
    producibilityGetReportInputSchema,
    (input, traceId) => service.getReport(input, traceId),
  );
  register(
    PRODUCIBILITY_IPC_CHANNELS.overrideFinding,
    producibilityOverrideFindingInputSchema,
    (input, traceId) => service.overrideFinding(input, traceId),
  );
};
