import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ProviderService } from '@jingxu/application';
import type { ProviderProfile, ProviderProfileDefaults, TextModelPort } from '@jingxu/application';
import type { AppResultDto } from '@jingxu/contracts';
import { QWEN_MODEL_ID, QwenTextModelAdapter, deriveQwenBaseUrl } from '@jingxu/model-adapters';

import { CredentialAdapter, type SafeStorageFacade } from '../adapters/credential';
import { E2eScriptTextModelAdapter } from '../adapters/e2e-script-text-model-adapter';
import { ProfileTextModelAdapter } from '../adapters/profile-text-model-adapter';
import { JobService } from '../jobs/job-service';
import {
  registerJobProviderGate,
  type JobProviderBoundaryService,
  type JobProviderIpcRegistrar,
  type StartupGate,
} from '../ipc/job-provider-gate';
import { createJobProviderIpcService } from '../ipc/job-provider-service';
import {
  createDesktopScriptGenerationRuntime,
  PRIMARY_QWEN_PROFILE_ID,
} from './create-script-generation-runtime';
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
  /** Enables the deterministic network-free model only for the explicit Electron E2E harness. */
  readonly useE2eMock?: boolean;
}

export interface JobProviderFeatureRegistration {
  ensureRegistered(): boolean;
  stop(): Promise<void>;
}

const DEFAULT_WORKSPACE_ID = 'jingxu';
const PROVIDER_DEFAULTS: ProviderProfileDefaults = {
  baseUrl: deriveQwenBaseUrl(DEFAULT_WORKSPACE_ID),
  modelId: QWEN_MODEL_ID,
  modelSnapshotDate: '2026-05-26',
  workspaceId: DEFAULT_WORKSPACE_ID,
};

const startupBlocked = <T>(traceId: string): AppResultDto<T> => ({
  error: {
    code: 'STARTUP_WRITE_BLOCKED',
    fieldErrors: null,
    message: '应用尚未进入可写状态。',
    retryable: true,
    traceId,
    userAction: '请先处理启动故障后重试。',
  },
  ok: false,
});

/** Registers the frozen IPC surface immediately and activates writable services once after READY. */
export const createJobProviderFeatureRegistration = ({
  clock,
  ipcRegistrar,
  managedRoot,
  newSubscriptionId,
  newTraceId,
  persistenceRuntime,
  safeStorage,
  trustedUrl,
  useE2eMock = false,
}: RegisterJobProviderFeaturesOptions): JobProviderFeatureRegistration => {
  const startupGate: StartupGate = {
    isWriteReady: () => persistenceRuntime.startupService.getStatus().writeEnabled,
  };
  const traceId = newTraceId ?? randomUUID;
  const subscriptionId = newSubscriptionId ?? randomUUID;
  let registered = false;
  let activeService: JobProviderBoundaryService | null = null;
  let stopRuntime: (() => Promise<void>) | null = null;

  const facade: JobProviderBoundaryService = {
    invoke: (channel, input) =>
      activeService === null
        ? Promise.resolve(startupBlocked('trace_startup_gate'))
        : activeService.invoke(channel, input),
  };
  registerJobProviderGate(ipcRegistrar, startupGate, () => facade, trustedUrl);

  return {
    ensureRegistered: () => {
      if (registered || !startupGate.isWriteReady()) return false;
      const providerUnitOfWork = persistenceRuntime.getProviderUnitOfWork();
      const profiles = persistenceRuntime.getProviderProfileRepository();
      const jobs = persistenceRuntime.getJobRepository();
      const scriptUnitOfWork = persistenceRuntime.getScriptUnitOfWork();
      const registry = persistenceRuntime.getSchemaRegistry();
      if (
        providerUnitOfWork === null ||
        profiles === null ||
        jobs === null ||
        scriptUnitOfWork === null ||
        registry === null
      ) {
        return false;
      }

      const credentials = new CredentialAdapter({
        clock,
        safeStorage,
        secretsDirectory: path.join(managedRoot, 'secrets'),
      });
      const createProviderAdapter = (profile: ProviderProfile): TextModelPort => {
        if (useE2eMock) return new E2eScriptTextModelAdapter();
        if (profile.credentialRef === null) throw new Error('PROVIDER_CREDENTIAL_MISSING');
        return new QwenTextModelAdapter({
          credentialId: profile.credentialRef,
          credentialPort: credentials,
          workspaceId: profile.workspaceId,
        });
      };
      const providerService = new ProviderService({
        clock,
        credentials,
        defaults: PROVIDER_DEFAULTS,
        profiles,
        textModelFactory: createProviderAdapter,
        unitOfWork: providerUnitOfWork,
      });
      const scriptRuntime = createDesktopScriptGenerationRuntime({
        clock,
        registry,
        textModel: new ProfileTextModelAdapter({
          createAdapter: createProviderAdapter,
          profileId: PRIMARY_QWEN_PROFILE_ID,
          profiles,
        }),
        unitOfWork: scriptUnitOfWork,
      });
      const jobService = new JobService({
        jobs,
        runner: scriptRuntime.runner,
        submission: scriptRuntime.submission,
      });

      activeService = createJobProviderIpcService({
        jobs: jobService,
        newSubscriptionId: subscriptionId,
        newTraceId: traceId,
        provider: providerService,
      });
      registered = true;
      stopRuntime = () => scriptRuntime.stop();
      void scriptRuntime.start();
      return true;
    },
    stop: () => stopRuntime?.() ?? Promise.resolve(),
  };
};
