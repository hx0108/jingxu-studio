import type { AppResultDto, ProjectErrorCode } from '@jingxu/contracts';

export const mediaFailure = <T>(
  code: ProjectErrorCode,
  message: string,
  traceId: string,
  retryable = false,
): AppResultDto<T> => ({
  ok: false,
  error: { code, fieldErrors: null, message, retryable, traceId, userAction: null },
});

export const mediaPersistenceFailure = <T>(traceId: string): AppResultDto<T> =>
  mediaFailure('MEDIA_PERSISTENCE_FAILED', '媒体数据暂时无法保存，请重试', traceId, true);
