import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { AppResultDto } from '@jingxu/contracts';
import { QWEN_MODEL_ID, QwenTextModelAdapter, deriveQwenBaseUrl } from '@jingxu/model-adapters';
import { ProviderService, recoverPendingJobs } from '@jingxu/application';
import type { JobRunner, ProviderProfile, ProviderProfileDefaults } from '@jingxu/application';

import { CredentialAdapter, type SafeStorageFacade } from '../adapters/credential';
import { JobService, type JobSubmissionPort } from '../jobs/job-service';
import {
  registerJobProviderGate,
  StartupJobRecoveryGate,
  type JobProviderBoundaryService,
  type JobProviderIpcRegistrar,
  type JobRecoveryPort,
  type StartupGate,
} from '../ipc/job-provider-gate';
import { createJobProviderIpcService } from '../ipc/job-provider-service';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';

export interface RegisterJobProviderFeaturesOptions {
  readonly clock: () => string;
  readonly ipcRegistrar: JobProviderIpcRegistrar;
  readonly managedRoot: string;
  readonly newSubscriptionId?: () => string;
  readonly newTraceId?: () => string;
  readonly persistenceRuntime: DesktopPersistenceRuntime;
  readonly safeStorage: SafeStorageFacade;
  readonly trustedUrl: string;
}

export interface JobProviderFeatureRegistration {
  /** 在 READY 后构造可写 Job/Provider 能力，且只激活一次；故障态不构造。 */
  ensureRegistered(): boolean;
}

/**
 * #5 默认 Provider 配置（占位）：模型固定为 `qwen3.7-plus-2026-05-26`，workspace 为占位
 * 值，真实 Provider/workspace/价格/数据处理快照在 #6 重新核对并以新 Change 固化
 *（Design §6、Risks「真实 Provider 配置漂移」）。Base URL 由受校验配置派生。
 */
const DEFAULT_WORKSPACE_ID = 'jingxu';
const PROVIDER_DEFAULTS: ProviderProfileDefaults = {
  baseUrl: deriveQwenBaseUrl(DEFAULT_WORKSPACE_ID),
  modelId: QWEN_MODEL_ID,
  modelSnapshotDate: '2026-05-26',
  workspaceId: DEFAULT_WORKSPACE_ID,
};

/**
 * #6/#7 业务 seam：装配剧本阶段业务输入并落 QUEUED Job、以原输入重新入队 FAILED Job。
 * 本 Change（#5）只交付通用 LLM 基座，真实 ScriptService 提交在 #6/#7 注入；IPC 层据此返回
 * `JOB_SUBMISSION_UNAVAILABLE`，而非空壳成功。
 */
const UNAVAILABLE_SUBMISSION: JobSubmissionPort = {
  requeue: () => Promise.reject(new Error('JOB_SUBMISSION_UNAVAILABLE')),
  submit: () => Promise.reject(new Error('JOB_SUBMISSION_UNAVAILABLE')),
};

/**
 * #6/#7 业务 seam：JobRunner 的 `run`/`cancel` 需要 `buildContract`/`buildRequest`/
 * `commitHandler`（剧本阶段业务装配），本 Change 不提供生产实现。JobService 仅在读路径与
 * 取消门上引用 runner；#5 无真实 Job 可运行，取消返回 `NOT_CANCELLED` → `JOB_NOT_CANCELLABLE`。
 */
const UNAVAILABLE_RUNNER: JobRunner = {
  cancel: () => Promise.resolve({ status: 'NOT_CANCELLED' }),
  run: () => Promise.reject(new Error('JOB_RUNNER_UNAVAILABLE')),
};

const startupBlocked = <T>(traceId: string): AppResultDto<T> => ({
  error: {
    code: 'STARTUP_WRITE_BLOCKED',
    fieldErrors: null,
    message: '应用尚未进入可写状态',
    retryable: true,
    traceId,
    userAction: '请先处理启动故障后重试',
  },
  ok: false,
});

/**
 * 注册 11 条 job/provider/events IPC 边界，但把可写的 JobRunner/ProviderService/
 * CredentialAdapter 构造推迟到启动审计到达 READY 之后。读命令在就绪前经 facade 归一化为
 * `STARTUP_WRITE_BLOCKED`，写命令由 gate 直接阻断。READY 后激活一次崩溃恢复扫描。
 */
export const createJobProviderFeatureRegistration = ({
  clock,
  ipcRegistrar,
  managedRoot,
  newSubscriptionId,
  newTraceId,
  persistenceRuntime,
  safeStorage,
  trustedUrl,
}: RegisterJobProviderFeaturesOptions): JobProviderFeatureRegistration => {
  const startupGate: StartupGate = {
    isWriteReady: () => persistenceRuntime.startupService.getStatus().writeEnabled,
  };
  const traceId = newTraceId ?? randomUUID;
  const subscriptionId = newSubscriptionId ?? randomUUID;

  let registered = false;
  let activeService: JobProviderBoundaryService | null = null;

  const facade: JobProviderBoundaryService = {
    invoke: (channel, input) =>
      activeService === null
        ? Promise.resolve(startupBlocked('trace_startup_gate'))
        : activeService.invoke(channel, input),
  };

  registerJobProviderGate(ipcRegistrar, startupGate, () => facade, trustedUrl);

  const createRecovery = (): JobRecoveryPort => ({
    recover: async () => {
      const jobUnitOfWork = persistenceRuntime.getJobUnitOfWork();
      if (jobUnitOfWork === null) return;
      await recoverPendingJobs(jobUnitOfWork, {
        now: clock,
        // #6 业务 seam：按持久化原始响应重算 hash 并比对；#5 无 pending Job，回调不被触发。
        responseHashMatches: () => false,
        // #6 业务 seam：确定性复检与版本提交（不调用 Provider）；#5 无 pending Job，回调不被触发。
        revalidate: () => Promise.reject(new Error('JOB_RECOVERY_REVALIDATE_UNAVAILABLE')),
      });
    },
  });
  const recoveryGate = new StartupJobRecoveryGate(startupGate, createRecovery);

  return {
    ensureRegistered: () => {
      if (registered || !startupGate.isWriteReady()) return false;
      const providerUnitOfWork = persistenceRuntime.getProviderUnitOfWork();
      const providerProfileRepository = persistenceRuntime.getProviderProfileRepository();
      const jobRepository = persistenceRuntime.getJobRepository();
      if (
        providerUnitOfWork === null ||
        providerProfileRepository === null ||
        jobRepository === null
      ) {
        return false;
      }

      const credentials = new CredentialAdapter({
        clock,
        safeStorage,
        secretsDirectory: path.join(managedRoot, 'secrets'),
      });
      const providerService = new ProviderService({
        clock,
        credentials,
        defaults: PROVIDER_DEFAULTS,
        profiles: providerProfileRepository,
        textModelFactory: (profile: ProviderProfile) => {
          if (profile.credentialRef === null) throw new Error('PROVIDER_CREDENTIAL_MISSING');
          return new QwenTextModelAdapter({
            credentialId: profile.credentialRef,
            credentialPort: credentials,
            workspaceId: profile.workspaceId,
          });
        },
        unitOfWork: providerUnitOfWork,
      });
      const jobService = new JobService({
        jobs: jobRepository,
        runner: UNAVAILABLE_RUNNER,
        submission: UNAVAILABLE_SUBMISSION,
      });

      activeService = createJobProviderIpcService({
        jobs: jobService,
        newSubscriptionId: subscriptionId,
        newTraceId: traceId,
        provider: providerService,
      });
      registered = true;
      // READY 后激活一次崩溃恢复（#5 无 pending Job → 扫描为空；业务 seam 在 #6 接入）。
      void recoveryGate.activate();
      return true;
    },
  };
};
