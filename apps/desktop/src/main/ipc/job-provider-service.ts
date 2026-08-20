import { randomUUID } from 'node:crypto';

import type { ModelErrorCode, ProviderProfileView, ProviderService } from '@jingxu/application';
import {
  appResultSchema,
  EVENTS_IPC_CHANNELS,
  JOB_IPC_CHANNELS,
  jobSummarySchema,
  PROVIDER_IPC_CHANNELS,
  providerProfileSchema,
  subscriptionResultSchema,
  type AppErrorDto,
  type AppResultDto,
  type JobCreateInputDto,
  type JobGetInputDto,
  type JobListInputDto,
  type JobMutationInputDto,
  type JobSummaryDto,
  type JobUpdatesSubscriptionDto,
  type ProjectErrorCode,
  type ProviderCredentialCommandDto,
  type ProviderGetInputDto,
  type ProviderMutationInputDto,
  type ProviderProfileCommandDto,
  type ProviderProfileDto,
  type SubscriptionResultDto,
} from '@jingxu/contracts';
import type { ZodType } from 'zod';

import type { JobService } from '../jobs/job-service';
import type { JobProviderBoundaryService } from './job-provider-gate';

interface MutationInput {
  readonly requestId: string;
}

interface CredentialTestFailureCopy {
  readonly message: string;
  readonly retryable: boolean;
  readonly userAction: string | null;
}

interface InFlightEntry {
  readonly signature: string;
  readonly promise: Promise<unknown>;
}

/**
 * 同进程 requestId singleflight：相同 requestId+signature 复用结果；相同 requestId
 * 不同 signature 视为复用冲突。跨进程/响应丢失仍由 SQLite 持久化与 idempotency_key 兜底。
 */
class RequestCoordinator {
  readonly #inFlight = new Map<string, InFlightEntry>();

  public run<T>(
    requestId: string,
    signature: string,
    operation: () => Promise<T>,
    conflict: () => T,
  ): Promise<T> {
    const found = this.#inFlight.get(requestId);
    if (found !== undefined) {
      if (found.signature !== signature) return Promise.resolve(conflict());
      return found.promise as Promise<T>;
    }
    const promise = Promise.resolve().then(operation);
    const entry: InFlightEntry = { promise, signature };
    this.#inFlight.set(requestId, entry);
    const cleanup = (): void => {
      if (this.#inFlight.get(requestId) === entry) this.#inFlight.delete(requestId);
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }
}

const toProviderDto = (view: ProviderProfileView): ProviderProfileDto => ({
  configured: view.configured,
  enabled: view.enabled,
  last4: view.last4,
  modelId: view.modelId,
  provider: view.provider,
  region: view.region,
  validated: view.lastValidatedAt !== null,
  versionId: view.versionId,
  workspaceId: view.workspaceId,
});

const ok = <T>(data: T): AppResultDto<T> => ({ data, ok: true });

const err = <T>(
  code: ProjectErrorCode,
  traceId: string,
  message: string,
  retryable: boolean,
  userAction: string | null,
): AppResultDto<T> => ({
  error: {
    code,
    fieldErrors: null,
    message,
    retryable,
    traceId,
    userAction,
  } satisfies AppErrorDto,
  ok: false,
});

const requestIdReused = <T>(traceId: string): AppResultDto<T> =>
  err('REQUEST_ID_REUSED', traceId, '请求 ID 已用于其他操作。', false, '请刷新后重新提交。');

/** 把 ProviderService 抛出的标记错误归一化为稳定 AppError；绝不回显原始 message/Key/Auth。 */
const mapProviderError = (
  error: unknown,
  traceId: string,
  fallback: ProjectErrorCode,
): AppResultDto<ProviderProfileDto> => {
  const marker = error instanceof Error ? error.message : '';
  if (marker === 'PROVIDER_PROFILE_NOT_FOUND') {
    return err<ProviderProfileDto>(
      'PROVIDER_PROFILE_NOT_FOUND',
      traceId,
      '未找到 Provider 配置。',
      false,
      null,
    );
  }
  if (marker === 'PROVIDER_CREDENTIAL_MISSING') {
    return err<ProviderProfileDto>(
      'PROVIDER_CREDENTIAL_MISSING',
      traceId,
      '请先保存 API Key。',
      false,
      null,
    );
  }
  return err<ProviderProfileDto>(fallback, traceId, 'Provider 操作失败，请重试。', true, null);
};

/**
 * 凭据测试失败码 → 用户可见文案的确定性映射（Renderer 只按 code 分支展示）。
 * code 与 message 均为固定枚举文案，不含 Provider 原始错误或实例值。
 */
const CREDENTIAL_TEST_FAILURES: Readonly<Record<ModelErrorCode, CredentialTestFailureCopy>> =
  Object.freeze({
    MODEL_CANCELLED: { message: '请求已取消。', retryable: false, userAction: null },
    MODEL_CONTENT_REJECTED: {
      message: '请求内容被 Provider 安全策略拒绝。',
      retryable: false,
      userAction: '请调整输入内容后重试。',
    },
    MODEL_CONTEXT_LIMIT: {
      message: '上下文长度超出模型限制。',
      retryable: false,
      userAction: '请减少输入长度后重试。',
    },
    MODEL_CREDENTIAL_INVALID: {
      message: 'API Key 校验未通过，Provider 拒绝了该凭据。',
      retryable: false,
      userAction: '请重新粘贴 API Key 并保存后再试。',
    },
    MODEL_INPUT_TOO_LARGE: {
      message: '请求体超出 Provider 大小限制。',
      retryable: false,
      userAction: '请减少输入长度后重试。',
    },
    MODEL_INVALID_RESPONSE: {
      message: 'Provider 返回内容无法解析。',
      retryable: true,
      userAction: '请重试。',
    },
    MODEL_NETWORK_ERROR: {
      message: '网络不可用或无法连接 Provider。',
      retryable: true,
      userAction: '请检查网络连接（含代理设置）后重试。',
    },
    MODEL_PROVIDER_ERROR: {
      message: 'Provider 服务端错误。',
      retryable: true,
      userAction: '请稍后重试；若持续失败请查看 Provider 状态页。',
    },
    MODEL_RATE_LIMITED: {
      message: 'Provider 限流，请稍后再试。',
      retryable: true,
      userAction: '请等待片刻后重试。',
    },
    MODEL_RESULT_UNAVAILABLE: {
      message: '生成结果已失效，无法下载。',
      retryable: false,
      userAction: '请重新生成候选。',
    },
    MODEL_TIMEOUT: {
      message: '请求超时。',
      retryable: true,
      userAction: '请重试；网络不佳时可稍后再试。',
    },
    MODEL_UNKNOWN: {
      message: 'Provider 调用失败，原因未知。',
      retryable: true,
      userAction: null,
    },
  });

/** 图片档解密校验的失败文案覆盖（spread 保持 ModelErrorCode 穷尽；其余 code 沿用文本档表）。 */
const IMAGE_CREDENTIAL_TEST_FAILURES: Readonly<Record<ModelErrorCode, CredentialTestFailureCopy>> =
  Object.freeze({
    ...CREDENTIAL_TEST_FAILURES,
    MODEL_CREDENTIAL_INVALID: {
      message: '图片 API Key 密文无法解密读取（未配置、系统密钥变更或目录迁移）。',
      retryable: false,
      userAction: '请在图片 Provider 设置中重新粘贴 ARK API Key 并保存。',
    },
  });

/** 视频档解密校验的失败文案覆盖（与图片档同语义，指向视频配置入口）。 */
const VIDEO_CREDENTIAL_TEST_FAILURES: Readonly<Record<ModelErrorCode, CredentialTestFailureCopy>> =
  Object.freeze({
    ...CREDENTIAL_TEST_FAILURES,
    MODEL_CREDENTIAL_INVALID: {
      message: '视频 API Key 密文无法解密读取（未配置、系统密钥变更或目录迁移）。',
      retryable: false,
      userAction: '请在视频 Provider 设置中重新粘贴 ARK API Key 并保存。',
    },
  });

export interface JobProviderIpcDependencies {
  /** 图片档（image-credential-management D1）：按 profileId 精确命中时分发到独立 ProviderService。 */
  readonly image?: Readonly<{ profileId: string; service: ProviderService }>;
  readonly jobs: JobService;
  readonly provider: ProviderService;
  /** 视频档（shot-video-generation D2）：按 profileId 精确命中时分发到独立 ProviderService。 */
  readonly video?: Readonly<{ profileId: string; service: ProviderService }>;
  readonly newTraceId?: () => string;
  readonly newSubscriptionId?: () => string;
}

const JOB_SUMMARY_RESULT = appResultSchema(jobSummarySchema);
const JOB_LIST_RESULT = appResultSchema(jobSummarySchema.array());
const PROVIDER_PROFILE_RESULT = appResultSchema(providerProfileSchema);
const SUBSCRIPTION_RESULT = appResultSchema(subscriptionResultSchema);

/** 防御性输出校验：结果偏离 DTO 即归一化为稳定错误，不向 Renderer 透传畸形结构。 */
const validateOutput = <T>(
  schema: ZodType,
  result: AppResultDto<T>,
  traceId: string,
): AppResultDto<T> => {
  const parsed = schema.safeParse(result);
  return parsed.success
    ? (parsed.data as AppResultDto<T>)
    : err('JOB_PERSISTENCE_FAILED', traceId, '响应校验失败。', true, null);
};

/**
 * 创建注入到 `registerJobProviderGate` 的边界服务：固定 11 频道路由、requestId
 * singleflight、`ProviderProfileView→DTO` 投影与脱敏错误归一化。Renderer 永不接收
 * Key、Authorization 或原始 Provider 错误。
 */
export const createJobProviderIpcService = (
  dependencies: JobProviderIpcDependencies,
): JobProviderBoundaryService => {
  const coordinator = new RequestCoordinator();
  const newTraceId = dependencies.newTraceId ?? randomUUID;
  const newSubscriptionId = dependencies.newSubscriptionId ?? randomUUID;
  const providerFor = (profileId: string): ProviderService => {
    if (dependencies.image?.profileId === profileId) return dependencies.image.service;
    if (dependencies.video?.profileId === profileId) return dependencies.video.service;
    return dependencies.provider;
  };
  const credentialTestFailuresFor = (
    profileId: string,
  ): Readonly<Record<ModelErrorCode, CredentialTestFailureCopy>> => {
    if (dependencies.image?.profileId === profileId) return IMAGE_CREDENTIAL_TEST_FAILURES;
    if (dependencies.video?.profileId === profileId) return VIDEO_CREDENTIAL_TEST_FAILURES;
    return CREDENTIAL_TEST_FAILURES;
  };

  const mutate = <T>(
    input: MutationInput,
    signature: string,
    traceId: string,
    operation: () => Promise<AppResultDto<T>>,
  ): Promise<AppResultDto<T>> =>
    coordinator.run(input.requestId, signature, operation, () => requestIdReused<T>(traceId));

  const jobCreate = async (
    input: JobCreateInputDto,
    traceId: string,
  ): Promise<AppResultDto<JobSummaryDto>> => {
    const result = await dependencies.jobs.create(input, traceId);
    return validateOutput(JOB_SUMMARY_RESULT, result, traceId);
  };
  const jobGet = async (
    input: JobGetInputDto,
    traceId: string,
  ): Promise<AppResultDto<JobSummaryDto>> => {
    const result = await dependencies.jobs.get(input.jobId, traceId);
    return validateOutput(JOB_SUMMARY_RESULT, result, traceId);
  };
  const jobList = async (
    input: JobListInputDto,
    traceId: string,
  ): Promise<AppResultDto<readonly JobSummaryDto[]>> => {
    const result = await dependencies.jobs.list(input, traceId);
    return validateOutput(JOB_LIST_RESULT, result as AppResultDto<JobSummaryDto[]>, traceId);
  };
  const jobCancel = async (
    input: JobMutationInputDto,
    traceId: string,
  ): Promise<AppResultDto<JobSummaryDto>> => {
    const result = await mutate(input, `${JOB_IPC_CHANNELS.cancel}:${input.jobId}`, traceId, () =>
      dependencies.jobs.cancel(input.jobId, input.expectedVersionId, traceId),
    );
    return validateOutput(JOB_SUMMARY_RESULT, result, traceId);
  };
  const jobRetry = async (
    input: JobMutationInputDto,
    traceId: string,
  ): Promise<AppResultDto<JobSummaryDto>> => {
    const result = await mutate(input, `${JOB_IPC_CHANNELS.retry}:${input.jobId}`, traceId, () =>
      dependencies.jobs.retry(input.jobId, input.expectedVersionId, traceId),
    );
    return validateOutput(JOB_SUMMARY_RESULT, result, traceId);
  };

  const providerGetProfile = async (
    input: ProviderGetInputDto,
    traceId: string,
  ): Promise<AppResultDto<ProviderProfileDto>> => {
    try {
      const view = await providerFor(input.profileId).getProfile(input.profileId);
      return validateOutput(PROVIDER_PROFILE_RESULT, ok(toProviderDto(view)), traceId);
    } catch {
      return mapProviderError(undefined, traceId, 'PROVIDER_CALL_FAILED');
    }
  };
  const providerSaveProfile = async (
    input: ProviderProfileCommandDto,
    traceId: string,
  ): Promise<AppResultDto<ProviderProfileDto>> => {
    const result = await mutate(
      input,
      `${PROVIDER_IPC_CHANNELS.saveProfile}:${input.profileId}`,
      traceId,
      async () => {
        try {
          const view = await providerFor(input.profileId).saveProfile(
            input.profileId,
            input.workspaceId,
            input.enabled,
          );
          return ok(toProviderDto(view));
        } catch (error) {
          return mapProviderError(error, traceId, 'PROVIDER_CALL_FAILED');
        }
      },
    );
    return validateOutput(PROVIDER_PROFILE_RESULT, result, traceId);
  };
  const providerSaveCredential = async (
    input: ProviderCredentialCommandDto,
    traceId: string,
  ): Promise<AppResultDto<ProviderProfileDto>> => {
    const result = await mutate(
      input,
      `${PROVIDER_IPC_CHANNELS.saveCredential}:${input.profileId}`,
      traceId,
      async () => {
        try {
          const view = await providerFor(input.profileId).saveCredential(
            input.profileId,
            input.apiKey,
          );
          return ok(toProviderDto(view));
        } catch (error) {
          return mapProviderError(error, traceId, 'PROVIDER_CREDENTIAL_UNAVAILABLE');
        }
      },
    );
    return validateOutput(PROVIDER_PROFILE_RESULT, result, traceId);
  };
  const providerTestCredential = async (
    input: ProviderMutationInputDto,
    traceId: string,
  ): Promise<AppResultDto<ProviderProfileDto>> => {
    const result = await mutate(
      input,
      `${PROVIDER_IPC_CHANNELS.testCredential}:${input.profileId}`,
      traceId,
      async () => {
        try {
          const check = await providerFor(input.profileId).testCredential(input.profileId);
          if (!check.ok) {
            // 透传模型端口的稳定失败码；表类型在编译期强制全键覆盖，
            // 运行时意外由外层 catch 归一化为 PROVIDER_CALL_FAILED。
            // 图片/视频档走解密校验语义，失败文案按档覆盖（D2）。
            const known = credentialTestFailuresFor(input.profileId)[check.errorCode];
            return err<ProviderProfileDto>(
              check.errorCode,
              traceId,
              known.message,
              known.retryable,
              known.userAction,
            );
          }
          const view = await providerFor(input.profileId).getProfile(input.profileId);
          return ok(toProviderDto(view));
        } catch (error) {
          return mapProviderError(error, traceId, 'PROVIDER_CALL_FAILED');
        }
      },
    );
    return validateOutput(PROVIDER_PROFILE_RESULT, result, traceId);
  };
  const providerDeleteCredential = async (
    input: ProviderMutationInputDto,
    traceId: string,
  ): Promise<AppResultDto<ProviderProfileDto>> => {
    const result = await mutate(
      input,
      `${PROVIDER_IPC_CHANNELS.deleteCredential}:${input.profileId}`,
      traceId,
      async () => {
        try {
          const view = await providerFor(input.profileId).deleteCredential(input.profileId);
          return ok(toProviderDto(view));
        } catch (error) {
          return mapProviderError(error, traceId, 'PROVIDER_CREDENTIAL_UNAVAILABLE');
        }
      },
    );
    return validateOutput(PROVIDER_PROFILE_RESULT, result, traceId);
  };
  const eventsSubscribe = (
    input: JobUpdatesSubscriptionDto,
    traceId: string,
  ): Promise<AppResultDto<SubscriptionResultDto>> => {
    void input;
    return Promise.resolve(
      validateOutput(SUBSCRIPTION_RESULT, ok({ subscriptionId: newSubscriptionId() }), traceId),
    );
  };

  return {
    invoke: async (channel: string, input: unknown): Promise<unknown> => {
      const traceId = newTraceId();
      switch (channel) {
        case JOB_IPC_CHANNELS.create:
          return jobCreate(input as JobCreateInputDto, traceId);
        case JOB_IPC_CHANNELS.get:
          return jobGet(input as JobGetInputDto, traceId);
        case JOB_IPC_CHANNELS.list:
          return jobList(input as JobListInputDto, traceId);
        case JOB_IPC_CHANNELS.cancel:
          return jobCancel(input as JobMutationInputDto, traceId);
        case JOB_IPC_CHANNELS.retry:
          return jobRetry(input as JobMutationInputDto, traceId);
        case PROVIDER_IPC_CHANNELS.getProfile:
          return providerGetProfile(input as ProviderGetInputDto, traceId);
        case PROVIDER_IPC_CHANNELS.saveProfile:
          return providerSaveProfile(input as ProviderProfileCommandDto, traceId);
        case PROVIDER_IPC_CHANNELS.saveCredential:
          return providerSaveCredential(input as ProviderCredentialCommandDto, traceId);
        case PROVIDER_IPC_CHANNELS.testCredential:
          return providerTestCredential(input as ProviderMutationInputDto, traceId);
        case PROVIDER_IPC_CHANNELS.deleteCredential:
          return providerDeleteCredential(input as ProviderMutationInputDto, traceId);
        case EVENTS_IPC_CHANNELS.subscribeJobUpdates:
          return eventsSubscribe(input as JobUpdatesSubscriptionDto, traceId);
        default:
          return err('IPC_INVALID_REQUEST', traceId, '未知频道。', false, null);
      }
    },
  };
};
