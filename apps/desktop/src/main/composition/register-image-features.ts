import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  createImageApiService,
  createMediaGenerationService,
  createMediaRequestBlueprintBuilder,
  createMediaTaskScheduler,
} from '@jingxu/application';
import type {
  FormatProfileRepository,
  ImageModelPort,
  MediaGenerationService,
} from '@jingxu/application';
import type { AppResultDto } from '@jingxu/contracts';
import {
  MockImageModelAdapter,
  SEEDREAM_INVOCATION_TIMEOUT_MS,
  SEEDREAM_MODEL_ID,
  SeedreamImageModelAdapter,
} from '@jingxu/model-adapters';
import { createContentAddressedStore, deriveMediaStorageRelPath } from '@jingxu/persistence';

import { CredentialAdapter, type SafeStorageFacade } from '../adapters/credential';
import { registerImageIpc, type ImageIpcRegistrar, type ImageIpcService } from '../ipc/image-ipc';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';

/** ARK Key 的 safeStorage 凭据引用（与 DashScope 主 Key 分存；配置流程随 7.x 联调接线）。 */
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
  /** Registers the six image IPC channels exactly once after persistence is writable. */
  ensureRegistered(): boolean;
  /** App shutdown: aborts in-flight provider segments without writing terminal phases. */
  stop(): Promise<void>;
}

const hashPayload = (value: Readonly<Record<string, unknown>>): string =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

/**
 * Pure image composition boundary. Registers the frozen six-method IPC surface immediately
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
    getMediaTask: (input, traceId) =>
      activeService?.getMediaTask(input, traceId) ?? Promise.resolve(blocked()),
    listAssets: (input, traceId) =>
      activeService?.listAssets(input, traceId) ?? Promise.resolve(blocked()),
    listCandidates: (input, traceId) =>
      activeService?.listCandidates(input, traceId) ?? Promise.resolve(blocked()),
    selectCandidate: (input, traceId) =>
      activeService?.selectCandidate(input, traceId) ?? Promise.resolve(blocked()),
    uploadAssetReference: (input, traceId) =>
      activeService?.uploadAssetReference(input, traceId) ?? Promise.resolve(blocked()),
  };
  registerImageIpc(
    ipcRegistrar,
    facade,
    { isWriteReady: () => persistenceRuntime.startupService.getStatus().writeEnabled },
    trustedUrl,
    ...(newTraceId === undefined ? [] : [{ newTraceId }]),
  );

  /**
   * 7.1 门控联调接线：设 JINGXU_IMAGE_CREDENTIAL_FILE（指向 ARK Key 明文文件）时，
   * 启动期一次性写入图片固定凭据（safeStorage 密文；wx 独占创建，已存在不覆盖，
   * 轮换需先删 secrets 文件）。Key 只经此路径入密文，不进环境快照、日志与数据库；
   * 任何失败只报原因码不回显内容。正式配置 UI 另行接线（design D5 红线不变）。
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
            // Mock 适配器逐次消耗声明式步骤：N 候选 = N 次 SYNC submit，耗尽即 MODEL_UNKNOWN。
            steps: Array.from({ length: IMAGE_CANDIDATE_COUNT }, () => ({ kind: 'SYNC' }) as const),
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
      const scheduler = createMediaTaskScheduler({
        fileStore: {
          writeImage: ({ bytes, mimeType, projectId }) =>
            store.write({ bytes, mimeType, namespace: 'images', projectId }),
        },
        imageModel,
        mediaUnitOfWork,
        newId: randomUUID,
        nowMs: Date.now,
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

      activeService = createImageApiService({
        assetFileStore: {
          writeAsset: ({ bytes, mimeType, projectId }) =>
            store.write({ bytes, mimeType, namespace: 'assets', projectId }),
        },
        generation,
        mediaUnitOfWork,
        newId: randomUUID,
        scheduler,
      });
      registered = true;
      stopScheduler = () => scheduler.stop();
      // 启动恢复：证据齐全的未终态任务续轮询，其余标记待人工；随后按项目后台排空。
      void projectUnitOfWork
        .run(({ projects }) => projects.findActiveNameRefs(null))
        .then((refs) =>
          Promise.all(
            refs.map(async (ref) => {
              await scheduler.recover(ref.projectId);
              scheduler.kick(ref.projectId);
            }),
          ),
        )
        .catch(() => undefined);
      return true;
    },
    stop: () => stopScheduler(),
  };
};
