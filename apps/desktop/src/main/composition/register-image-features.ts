import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  createImageApiService,
  createMediaBatchService,
  createMediaGenerationService,
  createMediaRequestBlueprintBuilder,
  createMediaTaskScheduler,
} from '@jingxu/application';
import type {
  FormatProfileRepository,
  ImageModelPort,
  MediaGenerationService,
  ModelErrorCode,
} from '@jingxu/application';
import type { AppResultDto } from '@jingxu/contracts';
import { MEDIA_BATCH_MAX_SHOTS } from '@jingxu/contracts';
import {
  MockImageModelAdapter,
  SEEDREAM_INVOCATION_TIMEOUT_MS,
  SEEDREAM_MODEL_ID,
  SeedreamImageModelAdapter,
  createMockModelError,
} from '@jingxu/model-adapters';
import type { MockImageSubmitStep } from '@jingxu/model-adapters';
import { createContentAddressedStore, deriveMediaStorageRelPath } from '@jingxu/persistence';

import { CredentialAdapter, type SafeStorageFacade } from '../adapters/credential';
import { registerImageIpc, type ImageIpcRegistrar, type ImageIpcService } from '../ipc/image-ipc';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';

/** ARK Key 的 safeStorage 凭据引用（与 DashScope 主 Key 分存；UI 配置走 provider 五通道，见 image-credential-management）。 */
export const IMAGE_CREDENTIAL_ID = 'profile-image-primary';
/** 每轮候选数 N（design D6-1：方舟无 n 参数，N 次独立请求聚合为一个任务行）。 */
const IMAGE_CANDIDATE_COUNT = 4;
/** 异步 Provider 单候选轮询截止（Seedream 为同步形态，此值仅护栏）。 */
const MEDIA_POLL_DEADLINE_MS = 10 * 60_000;
const MEDIA_POLL_INTERVAL_MS = 2_000;

export interface RegisterImageFeaturesOptions {
  readonly clock: () => string;
  readonly ipcRegistrar: ImageIpcRegistrar;
  readonly managedRoot: string;
  readonly newTraceId?: () => string;
  readonly persistenceRuntime: DesktopPersistenceRuntime;
  readonly safeStorage: SafeStorageFacade;
  readonly trustedUrl: string;
  /** Enables the deterministic network-free image model only for the Electron E2E harness. */
  readonly useE2eMock?: boolean;
}

export interface ImageFeatureRegistration {
  /** Registers the nine image IPC channels exactly once after persistence is writable. */
  ensureRegistered(): boolean;
  /** App shutdown: aborts in-flight provider segments without writing terminal phases. */
  stop(): Promise<void>;
}

const hashPayload = (value: Readonly<Record<string, unknown>>): string =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

/**
 * E2E 图片 Mock 步骤脚本化（仅 useE2eMock 下消费）：JINGXU_E2E_IMAGE_STEPS 为逗号
 * 分隔令牌——`S`=SYNC、`S:800`=SYNC 延迟 800ms（慢步骤制造在飞窗口，供取消/重启
 * 场景抢占）、`E:MODEL_TIMEOUT`=ERROR 候选级失败。缺省回落全 SYNC 预算（单批上限
 * 20 镜头 × 4 候选，兼作失控循环熔断）；非法令牌启动期即抛——失败要响，不带病运行。
 */
const parseE2eImageSteps = (): readonly MockImageSubmitStep[] => {
  const raw = process.env.JINGXU_E2E_IMAGE_STEPS;
  if (raw === undefined || raw.trim() === '') {
    return Array.from(
      { length: IMAGE_CANDIDATE_COUNT * MEDIA_BATCH_MAX_SHOTS },
      () => ({ kind: 'SYNC' }) as const,
    );
  }
  return raw.split(',').map((token): MockImageSubmitStep => {
    const trimmed = token.trim();
    if (trimmed === 'S') return { kind: 'SYNC' };
    const syncDelay = /^S:(\d+)$/u.exec(trimmed);
    if (syncDelay !== null) {
      return { afterMs: Number(syncDelay[1] ?? 0), kind: 'SYNC' };
    }
    const failure = /^E:([A-Z][A-Z0-9_]*)$/u.exec(trimmed);
    if (failure !== null) {
      return { error: createMockModelError(failure[1] as ModelErrorCode), kind: 'ERROR' };
    }
    throw new Error(`JINGXU_E2E_IMAGE_STEPS_INVALID_TOKEN: ${trimmed}`);
  });
};

/**
 * Pure image composition boundary. Registers the frozen nine-method IPC surface immediately
 * (STARTUP_WRITE_BLOCKED until READY) and activates the scheduler + services once after
 * startup reaches writable state, mirroring the Script feature registration lifecycle.
 */
export const createImageFeatureRegistration = ({
  clock,
  ipcRegistrar,
  managedRoot,
  newTraceId,
  persistenceRuntime,
  safeStorage,
  trustedUrl,
  useE2eMock = false,
}: RegisterImageFeaturesOptions): ImageFeatureRegistration => {
  let registered = false;
  let activeService: ImageIpcService | null = null;
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
  const facade: ImageIpcService = {
    generateCandidates: (input, traceId) =>
      activeService?.generateCandidates(input, traceId) ?? Promise.resolve(blocked()),
    generateCandidatesForShots: (input, traceId) =>
      activeService?.generateCandidatesForShots(input, traceId) ?? Promise.resolve(blocked()),
    getMediaTask: (input, traceId) =>
      activeService?.getMediaTask(input, traceId) ?? Promise.resolve(blocked()),
    listAssets: (input, traceId) =>
      activeService?.listAssets(input, traceId) ?? Promise.resolve(blocked()),
    listCandidates: (input, traceId) =>
      activeService?.listCandidates(input, traceId) ?? Promise.resolve(blocked()),
    listStoryboardImageStates: (input, traceId) =>
      activeService?.listStoryboardImageStates(input, traceId) ?? Promise.resolve(blocked()),
    selectCandidate: (input, traceId) =>
      activeService?.selectCandidate(input, traceId) ?? Promise.resolve(blocked()),
    uploadAssetReference: (input, traceId) =>
      activeService?.uploadAssetReference(input, traceId) ?? Promise.resolve(blocked()),
    cancelBatch: (input, traceId) =>
      activeService?.cancelBatch(input, traceId) ?? Promise.resolve(blocked()),
  };
  registerImageIpc(
    ipcRegistrar,
    facade,
    { isWriteReady: () => persistenceRuntime.startupService.getStatus().writeEnabled },
    trustedUrl,
    ...(newTraceId === undefined ? [] : [{ newTraceId }]),
  );

  /**
   * 门控联调接线（保留路径）：设 JINGXU_IMAGE_CREDENTIAL_FILE（指向 ARK Key 明文文件）
   * 且非 E2E Mock 时，启动期一次性写入图片固定凭据（safeStorage 密文；wx 独占创建，
   * 已存在不覆盖——不吞并 UI 已保存的 Key）。Key 只经此路径入密文，不进环境快照、
   * 日志与数据库；任何失败只报原因码不回显内容。正式配置走 provider 五通道的图片档
   * （ProviderSettings 图片卡片，保存即覆写轮换同一固定引用；design D5 红线不变）。
   */
  const bootstrapImageCredential = (): void => {
    const keyFile = process.env.JINGXU_IMAGE_CREDENTIAL_FILE;
    if (keyFile === undefined || keyFile === '' || useE2eMock) return;
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE');
      const plaintext = readFileSync(keyFile, 'utf8').replace(/^﻿/u, '').trim();
      if (plaintext.length === 0) throw new Error('EMPTY_KEY_FILE');
      const secretsDirectory = path.join(managedRoot, 'secrets');
      mkdirSync(secretsDirectory, { recursive: true });
      writeFileSync(
        path.join(secretsDirectory, `${IMAGE_CREDENTIAL_ID}.bin`),
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
        process.stderr.write(`镜序 Studio 图片凭据联调接线失败：${reason}\n`);
      }
    }
  };

  return {
    ensureRegistered: () => {
      if (registered || !persistenceRuntime.startupService.getStatus().writeEnabled) return false;
      const mediaUnitOfWork = persistenceRuntime.getMediaUnitOfWork();
      const workspaceQuery = persistenceRuntime.getScriptWorkspaceQuery();
      const projectUnitOfWork = persistenceRuntime.getProjectUnitOfWork();
      const formatProfileRepository = persistenceRuntime.getFormatProfileRepository();
      if (
        mediaUnitOfWork === null ||
        workspaceQuery === null ||
        projectUnitOfWork === null ||
        formatProfileRepository === null
      ) {
        return false;
      }
      bootstrapImageCredential();

      const store = createContentAddressedStore(managedRoot);
      const credentials = new CredentialAdapter({
        clock,
        safeStorage,
        secretsDirectory: path.join(managedRoot, 'secrets'),
      });
      const imageModel: ImageModelPort = useE2eMock
        ? new MockImageModelAdapter({
            // Mock 适配器逐次消耗声明式步骤且实例应用级共享（预算外提交按
            // MODEL_UNKNOWN 候选级失败，兼作失控循环的天然熔断）。
            steps: parseE2eImageSteps(),
          })
        : new SeedreamImageModelAdapter({
            credentialId: IMAGE_CREDENTIAL_ID,
            credentialPort: credentials,
            modelId: SEEDREAM_MODEL_ID,
          });

      // 画幅解析是只读查询且会在媒体事务内发生：必须直连连接，若经
      // projectUnitOfWork.run 排队，共享 FIFO 事务队列会与外层媒体事务自锁
      // （5.3 E2E 实证：先表现为 "cannot start a transaction within a transaction"）。
      const formatProfiles: Pick<FormatProfileRepository, 'findAllByProject'> =
        formatProfileRepository;
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
              namespace: 'assets',
              projectId,
            }),
          ),
      };
      const generation: MediaGenerationService = createMediaGenerationService({
        candidateCount: IMAGE_CANDIDATE_COUNT,
        formatProfiles,
        hashPayload,
        mediaUnitOfWork,
        modelId: SEEDREAM_MODEL_ID,
        newId: randomUUID,
        parametersFingerprint: (size) => `seedream-v1:${String(size.width)}x${String(size.height)}`,
        workspaceQuery,
      });
      // 批次与调度器循环依赖以晚绑定解开：批次建批后 kick，调度器排空后推进批次。
      let kickScheduler: ((projectId: string) => void) | null = null;
      const batch = createMediaBatchService({
        candidateCount: IMAGE_CANDIDATE_COUNT,
        formatProfiles,
        generation,
        hashPayload,
        kick: (projectId) => {
          kickScheduler?.(projectId);
        },
        mediaUnitOfWork,
        modelId: SEEDREAM_MODEL_ID,
        newId: randomUUID,
        parametersFingerprint: (size) => `seedream-v1:${String(size.width)}x${String(size.height)}`,
        workspaceQuery,
      });
      const scheduler = createMediaTaskScheduler({
        fileStore: {
          writeImage: ({ bytes, mimeType, projectId }) =>
            store.write({ bytes, mimeType, namespace: 'images', projectId }),
        },
        imageModel,
        mediaUnitOfWork,
        newId: randomUUID,
        nowMs: Date.now,
        onProjectIdle: (projectId) => batch.progressBatch(projectId),
        pollDeadlineMs: MEDIA_POLL_DEADLINE_MS,
        pollIntervalMs: MEDIA_POLL_INTERVAL_MS,
        requestBuilder: createMediaRequestBlueprintBuilder({
          formatProfiles,
          mediaUnitOfWork,
          referenceImages,
          workspaceQuery,
        }),
        segmentTimeoutMs: SEEDREAM_INVOCATION_TIMEOUT_MS,
        sleep: (milliseconds) =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, milliseconds);
          }),
      });
      kickScheduler = (projectId) => {
        scheduler.kick(projectId);
      };

      activeService = createImageApiService({
        assertCredentialReady:
          // Mock 档不设闸（无凭据依赖）；真实档在生成前解密探一次，
          // 未配置/不可解密以稳定 MODEL_CREDENTIAL_INVALID 拒绝（D2，替代 MODEL_UNKNOWN 兜底）。
          useE2eMock
            ? undefined
            : async () => {
                await credentials.loadCredential(IMAGE_CREDENTIAL_ID);
              },
        assetFileStore: {
          writeAsset: ({ bytes, mimeType, projectId }) =>
            store.write({ bytes, mimeType, namespace: 'assets', projectId }),
        },
        batch,
        generation,
        mediaUnitOfWork,
        newId: randomUUID,
        scheduler,
      });
      registered = true;
      stopScheduler = () => scheduler.stop();
      // 启动恢复：证据齐全的未终态任务续轮询，其余标记待人工；随后按项目后台排空。
      // 含 RUNNING 批次的项目在 recover 后补 kick——排空钩子继续消费待建档队列
      // （3.3 批次恢复；已建档成员的重发禁令由 recover 分类保证，批次层不重发）。
      void projectUnitOfWork
        .run(({ projects }) => projects.findActiveNameRefs(null))
        .then(async (refs) => {
          await Promise.all(
            refs.map(async (ref) => {
              await scheduler.recover(ref.projectId);
              scheduler.kick(ref.projectId);
            }),
          );
          const batchProjectIds = await mediaUnitOfWork.run((media) =>
            media.listRunningBatchProjectIds(),
          );
          for (const projectId of batchProjectIds) scheduler.kick(projectId);
        })
        .catch(() => undefined);
      return true;
    },
    stop: () => stopScheduler(),
  };
};
