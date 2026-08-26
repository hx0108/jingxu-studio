import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ProviderService } from '@jingxu/application';
import type {
  CredentialCheck,
  ProviderProfile,
  ProviderProfileDefaults,
  TextModelPort,
} from '@jingxu/application';
import type { AppResultDto } from '@jingxu/contracts';
import {
  QWEN_MODEL_ID,
  QWEN_TTS_MODEL_ID,
  QWEN_TTS_MODELS,
  QwenTextModelAdapter,
  SELECTABLE_SEEDANCE_VIDEO_MODELS,
  SEEDANCE_MODEL_ID,
  SEEDREAM_MODEL_ID,
  deriveQwenBaseUrl,
  deriveSeedanceBaseUrl,
  deriveSeedreamBaseUrl,
} from '@jingxu/model-adapters';

import { CredentialAdapter, type SafeStorageFacade } from '../adapters/credential';
import {
  E2eScriptTextModelAdapter,
  type E2eFailureScenario,
} from '../adapters/e2e-script-text-model-adapter';
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
import { IMAGE_CREDENTIAL_ID } from './register-image-features';
import { VIDEO_CREDENTIAL_ID } from './register-video-features';
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
  provider: 'QWEN',
  workspaceId: DEFAULT_WORKSPACE_ID,
};

/**
 * 图片档（D1=A）：profileId 与固定凭据引用同名；Seedream 生成路径不读该行
 * （按 IMAGE_CREDENTIAL_ID 直读密文），行只承载配置状态/末 4 位/审计。
 * ARK 无工作区概念——workspace_id 为 DB NOT NULL 惰性占位，UI 不展示、不参与请求。
 */
const IMAGE_PROFILE_ID = IMAGE_CREDENTIAL_ID;
const IMAGE_PROVIDER_DEFAULTS: ProviderProfileDefaults = {
  baseUrl: deriveSeedreamBaseUrl(),
  modelId: SEEDREAM_MODEL_ID,
  // 取自锁定 model id 的 yymmdd 版本段：doubao-seedream-5-0-lite-260128 → 2026-01-28。
  modelSnapshotDate: '2026-01-28',
  provider: 'VOLCARK_SEEDREAM',
  workspaceId: 'ark',
};

/**
 * 视频档（shot-video-generation D2）：与图片档同构——profileId 与固定凭据引用同名；
 * Seedance 生成路径不读该行（按 VIDEO_CREDENTIAL_ID 直读密文），行只承载配置状态/
 * 末 4 位/审计。同 ARK 平台无工作区概念，workspace_id 为 DB NOT NULL 惰性占位。
 */
const VIDEO_PROFILE_ID = VIDEO_CREDENTIAL_ID;
const VIDEO_PROVIDER_DEFAULTS: ProviderProfileDefaults = {
  baseUrl: deriveSeedanceBaseUrl(),
  modelId: SEEDANCE_MODEL_ID,
  // 默认档 Seedance-2.0：doubao-seedance-2-0-260128 → 2026-01-28。
  modelSnapshotDate: '2026-01-28',
  provider: 'VOLCARK_SEEDANCE',
  workspaceId: 'ark',
};

/**
 * 配音档（v2-voice-audio-timeline D1）：与图片/视频档同构——profileId 与固定凭据引用同名；
 * 生成路径不读该行（按 VOICE_PROFILE_ID 直读密文），行只承载配置状态/末 4 位/审计。
 * DashScope 平台无工作区概念，workspace_id 为 DB NOT NULL 惰性占位。
 */
const VOICE_PROFILE_ID = 'profile-voice-primary';
const VOICE_PROVIDER_DEFAULTS: ProviderProfileDefaults = {
  baseUrl: 'https://dashscope.aliyuncs.com',
  modelId: QWEN_TTS_MODEL_ID,
  modelSnapshotDate: '2026-01-26',
  provider: 'QWEN_TTS',
  workspaceId: 'dashscope',
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
      const e2eTextModel = useE2eMock
        ? new E2eScriptTextModelAdapter(
            (process.env.JINGXU_E2E_FAILURE_SCENARIO ?? null) as E2eFailureScenario | null,
          )
        : null;
      const createProviderAdapter = (profile: ProviderProfile): TextModelPort => {
        if (e2eTextModel !== null) return e2eTextModel;
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
      // 图片档凭据：固定 id + 覆写轮换（与文本档共享 secrets 目录；文本档仍为随机 id + wx）。
      const imageCredentials = new CredentialAdapter({
        clock,
        createId: () => IMAGE_PROFILE_ID,
        overwriteExisting: true,
        safeStorage,
        secretsDirectory: path.join(managedRoot, 'secrets'),
      });
      // 图片档 testCredential = 解密加载校验（D2=A：零计费请求；ARK 无免费探测端点）。
      const imageCredentialValidator = {
        validateCredential: async (): Promise<CredentialCheck> => {
          try {
            await imageCredentials.loadCredential(IMAGE_PROFILE_ID);
            return { ok: true };
          } catch {
            return { detail: null, errorCode: 'MODEL_CREDENTIAL_INVALID', ok: false };
          }
        },
      };
      const imageProviderService = new ProviderService({
        clock,
        credentials: imageCredentials,
        defaults: IMAGE_PROVIDER_DEFAULTS,
        profiles,
        textModelFactory: () => imageCredentialValidator,
        unitOfWork: providerUnitOfWork,
      });
      // 视频档凭据：与图片档同构（固定 id + 覆写轮换；Seedance 同 ARK Key 体系）。
      const videoCredentials = new CredentialAdapter({
        clock,
        createId: () => VIDEO_PROFILE_ID,
        overwriteExisting: true,
        safeStorage,
        secretsDirectory: path.join(managedRoot, 'secrets'),
      });
      // 视频档 testCredential 同为解密加载校验（零计费请求）。
      const videoCredentialValidator = {
        validateCredential: async (): Promise<CredentialCheck> => {
          try {
            await videoCredentials.loadCredential(VIDEO_PROFILE_ID);
            return { ok: true };
          } catch {
            return { detail: null, errorCode: 'MODEL_CREDENTIAL_INVALID', ok: false };
          }
        },
      };
      const videoProviderService = new ProviderService({
        clock,
        credentials: videoCredentials,
        defaults: VIDEO_PROVIDER_DEFAULTS,
        profiles,
        selectableModels: SELECTABLE_SEEDANCE_VIDEO_MODELS.map((model) => ({
          id: model.id,
          snapshotDate: model.snapshotDate,
        })),
        textModelFactory: () => videoCredentialValidator,
        unitOfWork: providerUnitOfWork,
      });
      // 配音档凭据：与图片/视频档同构（固定 id + 覆写轮换；DashScope Key 与 QWEN 文本档同值）。
      const voiceCredentials = new CredentialAdapter({
        clock,
        createId: () => VOICE_PROFILE_ID,
        overwriteExisting: true,
        safeStorage,
        secretsDirectory: path.join(managedRoot, 'secrets'),
      });
      // 配音档 testCredential 同为解密加载校验（零计费请求）。
      const voiceCredentialValidator = {
        validateCredential: async (): Promise<CredentialCheck> => {
          try {
            await voiceCredentials.loadCredential(VOICE_PROFILE_ID);
            return { ok: true };
          } catch {
            return { detail: null, errorCode: 'MODEL_CREDENTIAL_INVALID', ok: false };
          }
        },
      };
      const voiceProviderService = new ProviderService({
        clock,
        credentials: voiceCredentials,
        defaults: VOICE_PROVIDER_DEFAULTS,
        profiles,
        selectableModels: QWEN_TTS_MODELS.map((model) => ({
          id: model.id,
          snapshotDate: model.snapshotDate,
        })),
        textModelFactory: () => voiceCredentialValidator,
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
        forceStaleInput: process.env.JINGXU_E2E_FAILURE_SCENARIO === 'stale',
      });
      const jobService = new JobService({
        jobs,
        runner: scriptRuntime.runner,
        submission: scriptRuntime.submission,
      });

      activeService = createJobProviderIpcService({
        image: { profileId: IMAGE_PROFILE_ID, service: imageProviderService },
        jobs: jobService,
        newSubscriptionId: subscriptionId,
        newTraceId: traceId,
        provider: providerService,
        video: { profileId: VIDEO_PROFILE_ID, service: videoProviderService },
        voice: { profileId: VOICE_PROFILE_ID, service: voiceProviderService },
      });
      registered = true;
      stopRuntime = () => scriptRuntime.stop();
      void scriptRuntime.start();
      return true;
    },
    stop: () => stopRuntime?.() ?? Promise.resolve(),
  };
};
