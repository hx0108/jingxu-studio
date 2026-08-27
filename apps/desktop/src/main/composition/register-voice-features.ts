import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  createVoiceGenerationScheduler,
  createVoiceGenerationService,
  createVoiceMappingService,
} from '@jingxu/application';
import type {
  MediaRepositories,
  MediaUnitOfWorkPort,
  TtsModelPort,
  VoiceGenerationRepositoryPort,
  VoiceMappingRepositoryPort,
} from '@jingxu/application';
import type { AppResultDto } from '@jingxu/contracts';
import { MEDIA_BATCH_MAX_SHOTS } from '@jingxu/contracts';
import {
  DEFAULT_QWEN_TTS_MODEL_ID,
  getQwenTtsModel,
  MockTtsModelAdapter,
  NARRATOR_DEFAULT_VOICE_ID,
  QWEN_TTS_VOICES,
  QwenTtsModelAdapter,
} from '@jingxu/model-adapters';
import { createContentAddressedStore } from '@jingxu/persistence';

import { CredentialAdapter, type SafeStorageFacade } from '../adapters/credential';
import { createVoiceAudioRegistrar } from '../adapters/voice-audio-registrar';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';
import { registerVoiceIpc, type VoiceIpcRegistrar, type VoiceIpcService } from '../ipc/voice-ipc';

/**
 * 配音档固定凭据引用（与 register-job-provider-features 的 VOICE_PROFILE_ID 同值）：
 * profileId 与密文文件同名；生成路径按此 ID 直读密文，行只承载配置状态/审计。
 */
export const VOICE_CREDENTIAL_ID = 'profile-voice-primary';

export interface RegisterVoiceFeaturesOptions {
  readonly clock: () => string;
  readonly ipcRegistrar: VoiceIpcRegistrar;
  readonly managedRoot: string;
  readonly newTraceId?: () => string;
  readonly persistenceRuntime: DesktopPersistenceRuntime;
  readonly safeStorage: SafeStorageFacade;
  readonly trustedUrl: string;
  /** Enables the deterministic network-free TTS model only for the Electron E2E harness. */
  readonly useE2eMock?: boolean;
}

export interface VoiceFeatureRegistration {
  /** Registers the six voice IPC channels exactly once after persistence is writable. */
  ensureRegistered(): boolean;
  /** App shutdown: cancels in-flight jobs (cancel persists first, then aborts). */
  stop(): Promise<void>;
}

const hashPayload = (value: Readonly<Record<string, unknown>>): string =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

const hashText = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** UoW 事务包裹：仓储方法即事务边界（两段式证据各相位独立提交）。 */
const throughVoice = <T>(
  mediaUnitOfWork: MediaUnitOfWorkPort,
  work: (repos: NonNullable<MediaRepositories['voice']>) => Promise<T>,
): Promise<T> =>
  mediaUnitOfWork.run(({ voice }) => {
    if (voice === undefined) throw new Error('VOICE_REPOSITORIES_UNAVAILABLE');
    return work(voice);
  });

/**
 * Pure voice composition boundary. Registers the frozen six-method IPC surface
 * immediately (STARTUP_WRITE_BLOCKED until READY) and activates mapping +
 * generation services and the scheduler once after startup reaches writable
 * state, mirroring the Video feature registration lifecycle.
 */
export const createVoiceFeatureRegistration = ({
  clock,
  ipcRegistrar,
  managedRoot,
  newTraceId,
  persistenceRuntime,
  safeStorage,
  trustedUrl,
  useE2eMock = false,
}: RegisterVoiceFeaturesOptions): VoiceFeatureRegistration => {
  let registered = false;
  let stopScheduler: () => Promise<void> = () => Promise.resolve();

  const blocked = <T>(): AppResultDto<T> => ({
    error: {
      code: 'STARTUP_WRITE_BLOCKED',
      fieldErrors: null,
      message: '应用尚未进入可写状态。',
      retryable: true,
      traceId: 'trace_startup_gate',
      userAction: '请先处理启动故障后重试。',
    },
    ok: false,
  });
  let activeMapping: ReturnType<typeof createVoiceMappingService> | null = null;
  let activeGeneration: ReturnType<typeof createVoiceGenerationService> | null = null;
  const facade: VoiceIpcService = {
    getMappings: (input, traceId) =>
      activeMapping?.getMappings(input, traceId) ?? Promise.resolve(blocked()),
    saveMapping: (input, traceId) =>
      activeMapping?.saveMapping(input, traceId) ?? Promise.resolve(blocked()),
    generateForEpisode: (input, traceId) =>
      activeGeneration?.generateForEpisode(input, traceId) ?? Promise.resolve(blocked()),
    getGenerations: (input, traceId) =>
      activeGeneration?.getGenerations(input, traceId) ?? Promise.resolve(blocked()),
    selectCandidate: (input, traceId) =>
      activeGeneration?.selectCandidate(input, traceId) ?? Promise.resolve(blocked()),
    deleteCandidate: (input, traceId) =>
      activeGeneration?.deleteCandidate(input, traceId) ?? Promise.resolve(blocked()),
  };
  registerVoiceIpc(
    ipcRegistrar,
    facade,
    { isWriteReady: () => persistenceRuntime.startupService.getStatus().writeEnabled },
    trustedUrl,
    ...(newTraceId === undefined ? [] : [{ newTraceId }]),
  );

  return {
    ensureRegistered: () => {
      if (registered || !persistenceRuntime.startupService.getStatus().writeEnabled) return false;
      const mediaUnitOfWork = persistenceRuntime.getMediaUnitOfWork();
      const providerProfiles = persistenceRuntime.getProviderProfileRepository();
      const workspaceQuery = persistenceRuntime.getScriptWorkspaceQuery();
      const projectUnitOfWork = persistenceRuntime.getProjectUnitOfWork();
      if (
        mediaUnitOfWork === null ||
        providerProfiles === null ||
        workspaceQuery === null ||
        projectUnitOfWork === null
      ) {
        return false;
      }

      // 仓储门面：每方法一事务（SQLite UoW 单连接 FIFO，串行安全）。
      const repositories: VoiceGenerationRepositoryPort = {
        appendJobEvidence: (jobId, entry) =>
          throughVoice(mediaUnitOfWork, (voice) =>
            voice.generation.appendJobEvidence(jobId, entry),
          ),
        cancelJob: (jobId, at) =>
          throughVoice(mediaUnitOfWork, (voice) => voice.generation.cancelJob(jobId, at)),
        deleteCandidate: (candidateId) =>
          throughVoice(mediaUnitOfWork, (voice) => voice.generation.deleteCandidate(candidateId)),
        finalizeCandidateFailed: (candidateId, errorCode, updatedAt) =>
          throughVoice(mediaUnitOfWork, (voice) =>
            voice.generation.finalizeCandidateFailed(candidateId, errorCode, updatedAt),
          ),
        finalizeCandidateSucceeded: (candidateId, registration, updatedAt) =>
          throughVoice(mediaUnitOfWork, (voice) =>
            voice.generation.finalizeCandidateSucceeded(candidateId, registration, updatedAt),
          ),
        finalizeJob: (jobId, status, updatedAt) =>
          throughVoice(mediaUnitOfWork, (voice) =>
            voice.generation.finalizeJob(jobId, status, updatedAt),
          ),
        findActiveJobByProject: (projectId) =>
          throughVoice(mediaUnitOfWork, (voice) =>
            voice.generation.findActiveJobByProject(projectId),
          ),
        findCandidate: (projectId, candidateId) =>
          throughVoice(mediaUnitOfWork, (voice) =>
            voice.generation.findCandidate(projectId, candidateId),
          ),
        findJobById: (projectId, jobId) =>
          throughVoice(mediaUnitOfWork, (voice) => voice.generation.findJobById(projectId, jobId)),
        findJobByRequest: (projectId, requestId) =>
          throughVoice(mediaUnitOfWork, (voice) =>
            voice.generation.findJobByRequest(projectId, requestId),
          ),
        insertCandidate: (candidate) =>
          throughVoice(mediaUnitOfWork, (voice) => voice.generation.insertCandidate(candidate)),
        insertJob: (job) =>
          throughVoice(mediaUnitOfWork, (voice) => voice.generation.insertJob(job)),
        interruptCandidate: (candidateId, errorCode, updatedAt) =>
          throughVoice(mediaUnitOfWork, (voice) =>
            voice.generation.interruptCandidate(candidateId, errorCode, updatedAt),
          ),
        listCandidatesByShot: (shotId) =>
          throughVoice(mediaUnitOfWork, (voice) => voice.generation.listCandidatesByShot(shotId)),
        listSucceededShotHashes: (projectId) =>
          throughVoice(mediaUnitOfWork, (voice) =>
            voice.generation.listSucceededShotHashes(projectId),
          ),
        markCandidatesStale: (candidateIds, updatedAt) =>
          throughVoice(mediaUnitOfWork, (voice) =>
            voice.generation.markCandidatesStale(candidateIds, updatedAt),
          ),
        markJobRunning: (jobId, updatedAt) =>
          throughVoice(mediaUnitOfWork, (voice) =>
            voice.generation.markJobRunning(jobId, updatedAt),
          ),
        nextRoundNo: (shotId) =>
          throughVoice(mediaUnitOfWork, (voice) => voice.generation.nextRoundNo(shotId)),
        selectCandidate: (candidateId, selectedAt) =>
          throughVoice(mediaUnitOfWork, (voice) =>
            voice.generation.selectCandidate(candidateId, selectedAt),
          ),
      };
      const mappingRepositories: VoiceMappingRepositoryPort = {
        listByProject: (projectId) =>
          throughVoice(mediaUnitOfWork, (voice) => voice.mapping.listByProject(projectId)),
        replaceAll: (projectId, mappings) =>
          throughVoice(mediaUnitOfWork, (voice) => voice.mapping.replaceAll(projectId, mappings)),
      };

      const credentials = new CredentialAdapter({
        clock,
        safeStorage,
        secretsDirectory: path.join(managedRoot, 'secrets'),
      });
      const ttsModel: TtsModelPort = useE2eMock
        ? new MockTtsModelAdapter({
            // E2E 预算：单批上限镜头数 × 1 候选的同步步骤（失控循环熔断）。
            steps: Array.from({ length: MEDIA_BATCH_MAX_SHOTS }, () => ({ kind: 'SYNC' }) as const),
          })
        : new QwenTtsModelAdapter({
            credentialId: VOICE_CREDENTIAL_ID,
            credentialPort: credentials,
          });
      const resolveCurrentModel = async (): Promise<Readonly<{ modelId: string }>> => {
        if (useE2eMock) return { modelId: DEFAULT_QWEN_TTS_MODEL_ID };
        const profile = await providerProfiles.findById(VOICE_CREDENTIAL_ID);
        const resolved = getQwenTtsModel(profile?.modelId ?? DEFAULT_QWEN_TTS_MODEL_ID);
        if (resolved === null) throw new Error('VOICE_MODEL_CONFIGURATION_INVALID');
        return { modelId: resolved.id };
      };

      activeMapping = createVoiceMappingService({
        allowedVoiceIds: QWEN_TTS_VOICES.map((voice) => voice.id),
        clock,
        mappings: mappingRepositories,
        narratorDefaultVoiceId: NARRATOR_DEFAULT_VOICE_ID,
        workspaceQuery,
      });
      const registrar = createVoiceAudioRegistrar({
        store: createContentAddressedStore(managedRoot),
      });
      // 建批与调度循环依赖以晚绑定解开：服务建档后 kick，调度器后台排空。
      let kickScheduler: ((projectId: string) => void) | null = null;
      const scheduler = createVoiceGenerationScheduler({
        clock,
        hashPayload,
        hashText,
        mappings: activeMapping,
        model: { resolveModel: resolveCurrentModel },
        newId: randomUUID,
        registerAudio: (payload, projectId) => registrar.register(payload, projectId),
        repositories,
        synthesize: (request, signal) => ttsModel.synthesize(request, signal),
        normalizeError: (error) => ttsModel.normalizeError(error),
        workspaceQuery,
      });
      kickScheduler = (projectId) => {
        scheduler.kick(projectId);
      };
      activeGeneration = createVoiceGenerationService({
        // Mock 档不设闸（无凭据依赖）；真实档未配置/不可解密在建批前稳定拒绝（R1）。
        ...(useE2eMock
          ? {}
          : {
              assertCredentialReady: async () => {
                await credentials.loadCredential(VOICE_CREDENTIAL_ID);
              },
            }),
        clock,
        hashPayload,
        hashText,
        mappings: activeMapping,
        model: { resolveModel: resolveCurrentModel },
        newId: randomUUID,
        repositories,
        scheduler: { kick: (projectId) => kickScheduler?.(projectId) },
        workspaceQuery,
      });
      registered = true;
      /** 关停取消目标：启动恢复与建批 kick 覆盖过的项目集合。 */
      const trackedProjects = new Set<string>();
      const kickTracked = (projectId: string): void => {
        trackedProjects.add(projectId);
        scheduler.kick(projectId);
      };
      kickScheduler = kickTracked;
      stopScheduler = async () => {
        await Promise.all([...trackedProjects].map((projectId) => scheduler.cancel(projectId)));
        await Promise.all(
          [...trackedProjects].map((projectId) => scheduler.whenSettled(projectId)),
        );
      };
      // 启动恢复：只信证据——无终态证据的 PENDING 候选标中断失败；随后 kick 续跑。
      void projectUnitOfWork
        .run(({ projects }) => projects.findActiveNameRefs(null))
        .then(async (refs) => {
          for (const ref of refs) {
            await scheduler.recover(ref.projectId);
            kickTracked(ref.projectId);
          }
        })
        .catch(() => undefined);
      return true;
    },
    stop: () => stopScheduler(),
  };
};
