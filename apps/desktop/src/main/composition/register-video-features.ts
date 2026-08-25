import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  createMediaTaskScheduler,
  createVideoApiService,
  createVideoBatchService,
  createVideoGenerationService,
  createVideoCompositionService,
  createVideoRequestBlueprintBuilder,
} from '@jingxu/application';
import type { ModelErrorCode, VideoModelPort, VideoResultRef } from '@jingxu/application';
import type { AppResultDto, VideoAudioAssetSummaryDto } from '@jingxu/contracts';
import { MEDIA_BATCH_MAX_SHOTS } from '@jingxu/contracts';
import {
  MockVideoModelAdapter,
  DEFAULT_SEEDANCE_VIDEO_MODEL_ID,
  getSeedanceVideoModel,
  SEEDANCE_DURATION_RANGE,
  SEEDANCE_MODEL_ID,
  SEEDANCE_VIDEO_SEGMENT_TIMEOUT_MS,
  SeedanceVideoModelAdapter,
  createMockModelError,
} from '@jingxu/model-adapters';
import type { MockVideoSubmitStep } from '@jingxu/model-adapters';
import { createContentAddressedStore, deriveMediaStorageRelPath } from '@jingxu/persistence';
import { createFfmpegVideoComposer } from '../adapters/ffmpeg-video-composer';
import { createVideoAudioFileSink } from './video-audio-file-sink';
import { createVideoExportFileSink } from './video-export-file-sink';

import { CredentialAdapter, type SafeStorageFacade } from '../adapters/credential';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';
import { registerVideoIpc, type VideoIpcRegistrar, type VideoIpcService } from '../ipc/video-ipc';
import type { VideoApiService } from '@jingxu/application';

/** ARK Key 的 safeStorage 凭据引用（视频独立档，与图片档分存；design D2）。 */
export const VIDEO_CREDENTIAL_ID = 'profile-video-primary';
/** 每轮候选数 N（拍板 D3）。 */
export const VIDEO_CANDIDATE_COUNT = 2;
/** ASYNC Provider 单候选轮询截止：视频段生成远慢于图片，分钟级预算。 */
export const VIDEO_POLL_DEADLINE_MS = 15 * 60_000;
export const VIDEO_POLL_INTERVAL_MS = 3_000;
/** Seedance 能力快照时长档位（[minSec, maxSec]；迁移 0012 快照同源）。 */
const VIDEO_DURATION_RANGE = {
  maxSec: SEEDANCE_DURATION_RANGE[1],
  minSec: SEEDANCE_DURATION_RANGE[0],
};

/**
 * E2E 视频 Mock 步骤脚本化（仅 useE2eMock 下消费）：JINGXU_E2E_VIDEO_STEPS 为逗号
 * 分隔令牌（design A3）——`A`=ASYNC 2 次 PENDING 轮询后 SUCCEEDED（默认轮询窗口）、
 * `A:800`=submit 延迟 800ms 的慢异步（制造在飞窗口，供取消/重启场景抢占）、
 * `A:P3`=3 次 PENDING、`A:P0`=首次 poll 即 SUCCEEDED（快速路径）、`A:800:P3`=组合、
 * `E:MODEL_TIMEOUT`=submit 期候选级失败、`T:800`=800ms 后超时。缺省回落全 `A`
 * 预算（单批上限 20 镜头 × 2 候选，兼作失控循环熔断）；非法令牌启动期即抛——
 * 失败要响，不带病运行。
 */
export const parseE2eVideoSteps = (): readonly MockVideoSubmitStep[] => {
  const raw = process.env.JINGXU_E2E_VIDEO_STEPS;
  if (raw === undefined || raw.trim() === '') {
    return Array.from(
      { length: VIDEO_CANDIDATE_COUNT * MEDIA_BATCH_MAX_SHOTS },
      () => ({ kind: 'ASYNC', pendingPolls: 2 }) as const,
    );
  }
  return raw.split(',').map((token): MockVideoSubmitStep => {
    const trimmed = token.trim();
    const failure = /^E:([A-Z][A-Z0-9_]*)$/u.exec(trimmed);
    if (failure !== null) {
      return { error: createMockModelError(failure[1] as ModelErrorCode), kind: 'ERROR' };
    }
    const timeout = /^T:(\d+)$/u.exec(trimmed);
    if (timeout !== null) {
      return { afterMs: Number(timeout[1] ?? 0), kind: 'TIMEOUT' };
    }
    const asyncStep = /^A(?::(\d+))?(?::P(\d+))?$/u.exec(trimmed);
    if (asyncStep !== null) {
      const afterMs = Number(asyncStep[1] ?? 0);
      const pendingPolls = Number(asyncStep[2] ?? 2);
      return {
        ...(afterMs > 0 ? { afterMs } : {}),
        kind: 'ASYNC',
        pendingPolls,
      };
    }
    throw new Error(`JINGXU_E2E_VIDEO_STEPS_INVALID_TOKEN: ${trimmed}`);
  });
};

export interface RegisterVideoFeaturesOptions {
  readonly clock: () => string;
  readonly ipcRegistrar: VideoIpcRegistrar;
  readonly managedRoot: string;
  readonly newTraceId?: () => string;
  readonly persistenceRuntime: DesktopPersistenceRuntime;
  readonly safeStorage: SafeStorageFacade;
  readonly trustedUrl: string;
  /** Deterministic E2E audio path; production uses the Main Open Dialog. */
  readonly audioImportFile?: string | undefined;
  /** Enables the deterministic network-free video model only for the Electron E2E harness. */
  readonly useE2eMock?: boolean;
  /** 轮询间隔测试注入（缺省 VIDEO_POLL_INTERVAL_MS；生产不传）。 */
  readonly pollIntervalMs?: number;
}

export interface VideoFeatureRegistration {
  /** Registers the seven video IPC channels exactly once after persistence is writable. */
  ensureRegistered(): boolean;
  /** App shutdown: aborts in-flight provider segments without writing terminal phases. */
  stop(): Promise<void>;
}

const hashPayload = (value: Readonly<Record<string, unknown>>): string =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

/**
 * Pure video composition boundary. Registers the frozen seven-method IPC surface immediately
 * (STARTUP_WRITE_BLOCKED until READY) and activates the scheduler + services once after
 * startup reaches writable state, mirroring the Image feature registration lifecycle.
 */
export const createVideoFeatureRegistration = ({
  clock,
  ipcRegistrar,
  managedRoot,
  newTraceId,
  persistenceRuntime,
  safeStorage,
  trustedUrl,
  audioImportFile,
  useE2eMock = false,
  pollIntervalMs = VIDEO_POLL_INTERVAL_MS,
}: RegisterVideoFeaturesOptions): VideoFeatureRegistration => {
  let registered = false;
  let activeService: VideoApiService | null = null;
  let activeCompositionService: ReturnType<typeof createVideoCompositionService> | null = null;
  const audioFileSink = createVideoAudioFileSink({
    ffprobePath: process.env.JINGXU_FFPROBE_PATH,
    importFile: audioImportFile,
  });
  const exportFileSink = createVideoExportFileSink({
    exportDirectory: process.env.JINGXU_E2E_EXPORT_DIR,
  });
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
  const facade: VideoIpcService = {
    generateVideoCandidates: (input, traceId) =>
      activeService?.generateVideoCandidates(input, traceId) ?? Promise.resolve(blocked()),
    listVideoCandidates: (input, traceId) =>
      activeService?.listVideoCandidates(input, traceId) ?? Promise.resolve(blocked()),
    selectVideoCandidate: (input, traceId) =>
      activeService?.selectVideoCandidate(input, traceId) ?? Promise.resolve(blocked()),
    getVideoTask: (input, traceId) =>
      activeService?.getVideoTask(input, traceId) ?? Promise.resolve(blocked()),
    generateVideosForShots: (input, traceId) =>
      activeService?.generateVideosForShots(input, traceId) ?? Promise.resolve(blocked()),
    cancelVideoBatch: (input, traceId) =>
      activeService?.cancelVideoBatch(input, traceId) ?? Promise.resolve(blocked()),
    listStoryboardVideoStates: (input, traceId) =>
      activeService?.listStoryboardVideoStates(input, traceId) ?? Promise.resolve(blocked()),
    createTimeline: (input, traceId) =>
      activeCompositionService?.createTimeline(input, traceId) ?? Promise.resolve(blocked()),
    getTimeline: (input, traceId) =>
      activeCompositionService?.getTimeline(input, traceId) ?? Promise.resolve(blocked()),
    updateTimeline: (input, traceId) =>
      activeCompositionService?.updateTimeline(input, traceId) ?? Promise.resolve(blocked()),
    importBackgroundMusic: (input, traceId) => {
      const service = activeCompositionService;
      if (service === null) return Promise.resolve(blocked<VideoAudioAssetSummaryDto>());
      return audioFileSink
        .readSelectedAudio()
        .then(async (selected) => {
          if (selected === null)
            return {
              ok: false as const,
              error: {
                code: 'VIDEO_AUDIO_INVALID' as const,
                fieldErrors: null,
                message: '已取消背景音乐导入。',
                retryable: false,
                traceId,
                userAction: '选择音频文件后重试。',
              },
            };
          const bytes = selected.bytes;
          const fileSha256 = createHash('sha256').update(bytes).digest('hex');
          const stored = await createContentAddressedStore(managedRoot).write({
            bytes,
            mimeType: selected.mimeType,
            namespace: 'audio',
            projectId: input.projectId,
          });
          return service.importBackgroundMusic(
            input,
            {
              byteSize: stored.byteSize,
              fileSha256,
              id: `audio_${randomUUID().replaceAll('-', '')}`,
              mimeType: selected.mimeType,
              originalFileName: selected.originalFileName,
              storageRelPath: stored.storageRelPath,
            },
            traceId,
          );
        })
        .catch(() => ({
          ok: false as const,
          error: {
            code: 'VIDEO_AUDIO_INVALID' as const,
            fieldErrors: null,
            message: '背景音乐无法读取或解码。',
            retryable: false,
            traceId,
            userAction: '选择可用的 MP3、WAV 或 M4A 后重试。',
          },
        }));
    },
    startExport: (input, traceId) =>
      activeCompositionService?.startExport(input, traceId) ?? Promise.resolve(blocked()),
    getExportJob: (input, traceId) =>
      activeCompositionService?.getExportJob(input, traceId) ?? Promise.resolve(blocked()),
    cancelExport: (input, traceId) =>
      activeCompositionService?.cancelExport(input, traceId) ?? Promise.resolve(blocked()),
  };
  registerVideoIpc(
    ipcRegistrar,
    facade,
    { isWriteReady: () => persistenceRuntime.startupService.getStatus().writeEnabled },
    trustedUrl,
    ...(newTraceId === undefined ? [] : [{ newTraceId }]),
  );

  /**
   * 门控联调接线（保留路径）：设 JINGXU_VIDEO_CREDENTIAL_FILE（指向 ARK Key 明文文件）
   * 且非 E2E Mock 时，启动期一次性写入视频固定凭据（safeStorage 密文；wx 独占创建，
   * 已存在不覆盖——不吞并 UI 已保存的 Key）。Key 只经此路径入密文，不进环境快照、
   * 日志与数据库；任何失败只报原因码不回显内容。正式配置走 provider 通道的视频档
   * （ProviderSettings 视频卡片；与图片档分存互不影响）。
   */
  const bootstrapVideoCredential = (): void => {
    const keyFile = process.env.JINGXU_VIDEO_CREDENTIAL_FILE;
    if (keyFile === undefined || keyFile === '' || useE2eMock) return;
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE');
      const plaintext = readFileSync(keyFile, 'utf8').replace(/^﻿/u, '').trim();
      if (plaintext.length === 0) throw new Error('EMPTY_KEY_FILE');
      const secretsDirectory = path.join(managedRoot, 'secrets');
      mkdirSync(secretsDirectory, { recursive: true });
      writeFileSync(
        path.join(secretsDirectory, `${VIDEO_CREDENTIAL_ID}.bin`),
        safeStorage.encryptString(plaintext),
        { flag: 'wx', mode: 0o600 },
      );
    } catch (error) {
      const failure = error as { code?: unknown; message?: unknown };
      const reason =
        typeof failure.code === 'string'
          ? failure.code
          : typeof failure.message === 'string'
            ? failure.message
            : 'UNKNOWN';
      if (reason !== 'EEXIST') {
        process.stderr.write(`镜序 Studio 视频凭据联调接线失败：${reason}\n`);
      }
    }
  };

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
      bootstrapVideoCredential();

      const store = createContentAddressedStore(managedRoot);
      const credentials = new CredentialAdapter({
        clock,
        safeStorage,
        secretsDirectory: path.join(managedRoot, 'secrets'),
      });
      const videoModel: VideoModelPort = useE2eMock
        ? new MockVideoModelAdapter({
            // Mock 适配器逐次消耗声明式步骤且实例应用级共享（预算外提交按
            // MODEL_UNKNOWN 候选级失败，兼作失控循环的天然熔断）。
            steps: parseE2eVideoSteps(),
          })
        : new SeedanceVideoModelAdapter({
            credentialId: VIDEO_CREDENTIAL_ID,
            credentialPort: credentials,
          });
      const resolveCurrentModel = async (): Promise<Readonly<{ modelId: string }>> => {
        if (useE2eMock) return { modelId: SEEDANCE_MODEL_ID };
        const profile = await providerProfiles.findById(VIDEO_CREDENTIAL_ID);
        const resolved = getSeedanceVideoModel(profile?.modelId ?? DEFAULT_SEEDANCE_VIDEO_MODEL_ID);
        if (resolved === null) throw new Error('VIDEO_MODEL_CONFIGURATION_INVALID');
        return { modelId: resolved.id };
      };
      // 首帧字节读取（images 命名空间，内容寻址）：与图片调度器写入路径同一落盘口径。
      const referenceImages = {
        readReference: ({
          fileSha256,
          mimeType,
          projectId,
        }: {
          readonly fileSha256: string;
          readonly mimeType: string;
          readonly projectId: string;
        }) =>
          store.read(
            deriveMediaStorageRelPath({
              fileSha256,
              mimeType,
              namespace: 'images',
              projectId,
            }),
          ),
      };
      const generation = createVideoGenerationService({
        candidateCount: VIDEO_CANDIDATE_COUNT,
        durationRange: VIDEO_DURATION_RANGE,
        hashPayload,
        mediaUnitOfWork,
        modelId: SEEDANCE_MODEL_ID,
        newId: randomUUID,
        workspaceQuery,
        resolveModel: resolveCurrentModel,
        // Mock 档不设闸（无凭据依赖）；真实档在生成前解密探一次，
        // 未配置/不可解密以稳定 MODEL_CREDENTIAL_INVALID 拒绝（A5）。
        ...(useE2eMock
          ? {}
          : {
              assertCredentialReady: async () => {
                await credentials.loadCredential(VIDEO_CREDENTIAL_ID);
              },
            }),
      });
      // 批次与调度器循环依赖以晚绑定解开：批次建批后 kick，调度器排空后推进批次。
      let kickScheduler: ((projectId: string) => void) | null = null;
      const batch = createVideoBatchService({
        durationRange: VIDEO_DURATION_RANGE,
        generation,
        hashPayload,
        kick: (projectId) => {
          kickScheduler?.(projectId);
        },
        mediaUnitOfWork,
        modelId: SEEDANCE_MODEL_ID,
        newId: randomUUID,
        workspaceQuery,
        resolveModel: resolveCurrentModel,
      });
      const scheduler = createMediaTaskScheduler({
        fileStore: {
          writeMedia: ({ bytes, mimeType, projectId }) =>
            store.write({ bytes, mimeType, namespace: 'videos', projectId }),
        },
        generation: (repos) => repos.video,
        hashText: (value) => createHash('sha256').update(value, 'utf8').digest('hex'),
        model: videoModel,
        mediaUnitOfWork,
        newId: randomUUID,
        nowMs: Date.now,
        onProjectIdle: (projectId) => batch.progressBatch(projectId),
        pollDeadlineMs: VIDEO_POLL_DEADLINE_MS,
        pollIntervalMs,
        recordPollEvidence: true,
        requestBuilder: createVideoRequestBlueprintBuilder({
          firstFrameReader: referenceImages,
          mediaUnitOfWork,
          workspaceQuery,
        }),
        resultMetaOf: (result) => ({
          actualDurationSec: (result as VideoResultRef).actualDurationSec,
        }),
        segmentTimeoutMs: SEEDANCE_VIDEO_SEGMENT_TIMEOUT_MS,
        sleep: (milliseconds) =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, milliseconds);
          }),
      });
      kickScheduler = (projectId) => {
        scheduler.kick(projectId);
      };

      activeService = createVideoApiService({
        // 批量建批前置闸与单镜头闸同源（单镜头闸已注入生成服务，API 层闸只护建批）。
        ...(useE2eMock
          ? {}
          : {
              assertCredentialReady: async () => {
                await credentials.loadCredential(VIDEO_CREDENTIAL_ID);
              },
            }),
        batch,
        generation,
        mediaUnitOfWork,
        scheduler,
      });
      activeCompositionService = createVideoCompositionService({
        composer: createFfmpegVideoComposer({
          delayBeforeComposeMs:
            useE2eMock && /^\d{1,5}$/u.test(process.env.JINGXU_E2E_VIDEO_COMPOSE_DELAY_MS ?? '')
              ? Number(process.env.JINGXU_E2E_VIDEO_COMPOSE_DELAY_MS)
              : 0,
          exportFileSink,
          managedRoot,
          store,
        }),
        hashPayload,
        mediaUnitOfWork,
        newId: randomUUID,
        resolveFormatProfile: async (projectId, formatProfileId) => {
          const profiles = await persistenceRuntime
            .getFormatProfileRepository()
            ?.findAllByProject(projectId);
          const profile = profiles?.find((entry) => entry.id === formatProfileId);
          return profile === undefined
            ? null
            : { fps: profile.spec.fps, height: profile.spec.height, width: profile.spec.width };
        },
        workspaceQuery,
      });
      registered = true;
      stopScheduler = () => scheduler.stop();
      // 启动恢复：证据齐全的未终态任务续轮询，其余标记待人工；随后按项目后台排空。
      // 含 RUNNING 批次的项目在 recover 后补 kick——排空钩子继续消费待建档队列
      // （已建档成员的重发禁令由 recover 分类保证，批次层不重发）。
      void projectUnitOfWork
        .run(({ projects }) => projects.findActiveNameRefs(null))
        .then(async (refs) => {
          await Promise.all(
            refs.map(async (ref) => {
              await activeCompositionService?.recoverUnfinishedExports(ref.projectId);
              await scheduler.recover(ref.projectId);
              scheduler.kick(ref.projectId);
            }),
          );
          const batchProjectIds = await mediaUnitOfWork.run(({ video }) =>
            video.listRunningBatchProjectIds(),
          );
          for (const projectId of batchProjectIds) scheduler.kick(projectId);
        })
        .catch(() => undefined);
      return true;
    },
    stop: () => stopScheduler(),
  };
};
