import type { AppResultDto, ProjectErrorCode } from '@jingxu/contracts';

export const scriptFailure = <T>(
  code: ProjectErrorCode,
  message: string,
  traceId: string,
  fieldErrors: Readonly<Record<string, string>> | null = null,
  retryable = false,
): AppResultDto<T> => ({
  ok: false,
  error: { code, fieldErrors, message, retryable, traceId, userAction: null },
});

export const scriptPersistenceFailure = <T>(traceId: string): AppResultDto<T> =>
  scriptFailure('PROJECT_PERSISTENCE_FAILED', '剧本数据暂时无法保存，请重试', traceId, null, true);
