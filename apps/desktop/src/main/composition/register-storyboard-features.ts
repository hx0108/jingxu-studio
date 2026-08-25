import { createHash, randomUUID } from 'node:crypto';

import {
  createShotEditLockService,
  createStoryboardExportService,
  createStoryboardStructuralEditService,
} from '@jingxu/application';
import type {
  CompiledSchemaRegistry,
  FormatProfileRepository,
  ScriptUnitOfWorkPort,
  ShotEditLockSummary,
  StoryboardExportFileSink,
} from '@jingxu/application';
import type { AppResultDto, ShotEditLockSummaryDto } from '@jingxu/contracts';

import {
  registerStoryboardIpc,
  type StoryboardIpcRegistrar,
  type StoryboardIpcService,
  type StoryboardIpcTraceIds,
} from '../ipc/storyboard-ipc';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';

export interface StoryboardRuntimeHandles {
  readonly appVersion: string;
  readonly exportSink: StoryboardExportFileSink;
  readonly formatProfiles: FormatProfileRepository;
  readonly registry: CompiledSchemaRegistry;
  readonly unitOfWork: ScriptUnitOfWorkPort;
}

export interface RegisterStoryboardFeaturesOptions {
  /** envelope export_provenance.app_version（Electron app.getVersion()）。 */
  readonly appVersion: string;
  readonly createService: (handles: StoryboardRuntimeHandles) => StoryboardIpcService;
  /** storyboard-export 落盘 sink（main 侧 save dialog；E2E 定名注入）。 */
  readonly exportSink: StoryboardExportFileSink;
  readonly ipcRegistrar: StoryboardIpcRegistrar;
  readonly newTraceId?: StoryboardIpcTraceIds['newTraceId'];
  readonly persistenceRuntime: DesktopPersistenceRuntime;
  readonly trustedUrl: string;
}

export interface StoryboardFeatureRegistration {
  /** Registers the three storyboard.* IPC channels exactly once after persistence is writable. */
  ensureRegistered(): boolean;
}

const SHOT_CONTRACT_SCHEMA_ID = 'https://jingxu.studio/schemas/shot-contract/1.1.0';
const EPISODE_STORYBOARD_EXPORT_SCHEMA_ID =
  'https://jingxu.studio/schemas/episode-storyboard-export/1.1.0';

const hashText = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const hashPayload = (value: Readonly<Record<string, unknown>>): string =>
  hashText(JSON.stringify(value));

const registryIssues = (issues: readonly { instancePath: string; keyword: string }[]): string[] =>
  issues.map((issue) => `${issue.instancePath}:${issue.keyword}`);

/** Creates the production shot edit/lock/export services; Schema 校验注入自 Schema Registry。 */
export const createProductionStoryboardService = (
  handles: StoryboardRuntimeHandles,
): StoryboardIpcService => {
  const service = createShotEditLockService({
    hashPayload,
    hashText,
    newId: randomUUID,
    now: (): string => new Date().toISOString(),
    unitOfWork: handles.unitOfWork,
    validateShotDocument: (document) => {
      const result = handles.registry.validate(SHOT_CONTRACT_SCHEMA_ID, document);
      return result.valid
        ? { valid: true }
        : {
            code: 'SHOT_CONTRACT_SCHEMA_INVALID',
            details: registryIssues(result.issues),
            valid: false,
          };
    },
  });
  const exportService = createStoryboardExportService({
    appVersion: handles.appVersion,
    formatProfiles: handles.formatProfiles,
    newId: randomUUID,
    now: (): string => new Date().toISOString(),
    sink: handles.exportSink,
    unitOfWork: handles.unitOfWork,
    validateExportDocument: (document) => {
      const result = handles.registry.validate(EPISODE_STORYBOARD_EXPORT_SCHEMA_ID, document);
      return result.valid
        ? { valid: true }
        : {
            code: 'EXPORT_ENVELOPE_SCHEMA_INVALID',
            details: registryIssues(result.issues),
            valid: false,
          };
    },
  });
  const structuralService = createStoryboardStructuralEditService({
    hashPayload,
    hashText,
    newId: randomUUID,
    now: (): string => new Date().toISOString(),
    unitOfWork: handles.unitOfWork,
  });
  // application 摘要的 readonly lockedPaths → 可序列化 DTO 数组。
  const toDto = (summary: ShotEditLockSummary): ShotEditLockSummaryDto => ({
    episode: summary.episode,
    lockedPaths: [...summary.lockedPaths],
    shotVersionId: summary.shotVersionId,
  });
  const adapt = (
    promise: Promise<AppResultDto<ShotEditLockSummary>>,
  ): Promise<AppResultDto<ShotEditLockSummaryDto>> =>
    promise.then((result) => (result.ok ? { data: toDto(result.data), ok: true } : result));
  return {
    editShot: (input, traceId) => adapt(service.editShot(input, traceId)),
    // 导出回执字段与 application 摘要同形（纯标量），直接透传。
    exportEpisode: (input, traceId) => exportService.exportEpisode(input, traceId),
    lockShot: (input, traceId) => adapt(service.lockShot(input, traceId)),
    unlockShot: (input, traceId) => adapt(service.unlockShot(input, traceId)),
    splitShot: (input, traceId) =>
      structuralService
        .mutate({ ...input, operation: 'SPLIT' }, traceId)
        .then((result) => (result.ok ? { data: toDto(result.data), ok: true } : result)),
    mergeShots: (input, traceId) =>
      structuralService
        .mutate(
          {
            ...input,
            operation: 'MERGE',
            shotIds: [input.shotIds[0] ?? '', input.shotIds[1] ?? ''],
          },
          traceId,
        )
        .then((result) => (result.ok ? { data: toDto(result.data), ok: true } : result)),
    copyShot: (input, traceId) =>
      structuralService
        .mutate({ ...input, operation: 'COPY' }, traceId)
        .then((result) => (result.ok ? { data: toDto(result.data), ok: true } : result)),
    reorderShots: (input, traceId) =>
      structuralService
        .mutate({ ...input, operation: 'REORDER' }, traceId)
        .then((result) => (result.ok ? { data: toDto(result.data), ok: true } : result)),
    deleteShot: (input, traceId) =>
      structuralService
        .mutate({ ...input, operation: 'DELETE' }, traceId)
        .then((result) => (result.ok ? { data: toDto(result.data), ok: true } : result)),
    restoreShot: (input, traceId) =>
      structuralService
        .mutate({ ...input, operation: 'RESTORE' }, traceId)
        .then((result) => (result.ok ? { data: toDto(result.data), ok: true } : result)),
  };
};

/**
 * Pure storyboard composition boundary. Mirrors the Script registration lifecycle:
 * channels are registered up front behind a blocked facade; the real service is
 * injected only after startup reaches READY (writeEnabled).
 */
export const createStoryboardFeatureRegistration = ({
  appVersion,
  createService,
  exportSink,
  ipcRegistrar,
  newTraceId,
  persistenceRuntime,
  trustedUrl,
}: RegisterStoryboardFeaturesOptions): StoryboardFeatureRegistration => {
  let registered = false;
  let activeService: StoryboardIpcService | null = null;
  const blocked = (): Promise<AppResultDto<never>> =>
    Promise.resolve({
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
  const facade: StoryboardIpcService = {
    editShot: (input, traceId) => activeService?.editShot(input, traceId) ?? blocked(),
    exportEpisode: (input, traceId) => activeService?.exportEpisode(input, traceId) ?? blocked(),
    lockShot: (input, traceId) => activeService?.lockShot(input, traceId) ?? blocked(),
    unlockShot: (input, traceId) => activeService?.unlockShot(input, traceId) ?? blocked(),
    splitShot: (input, traceId) => activeService?.splitShot?.(input, traceId) ?? blocked(),
    mergeShots: (input, traceId) => activeService?.mergeShots?.(input, traceId) ?? blocked(),
    copyShot: (input, traceId) => activeService?.copyShot?.(input, traceId) ?? blocked(),
    reorderShots: (input, traceId) => activeService?.reorderShots?.(input, traceId) ?? blocked(),
    deleteShot: (input, traceId) => activeService?.deleteShot?.(input, traceId) ?? blocked(),
    restoreShot: (input, traceId) => activeService?.restoreShot?.(input, traceId) ?? blocked(),
  };
  registerStoryboardIpc(
    ipcRegistrar,
    facade,
    { isWriteReady: () => persistenceRuntime.startupService.getStatus().writeEnabled },
    trustedUrl,
    ...(newTraceId === undefined ? [] : [{ newTraceId }]),
  );
  return {
    ensureRegistered: () => {
      if (registered || !persistenceRuntime.startupService.getStatus().writeEnabled) return false;
      const unitOfWork = persistenceRuntime.getScriptUnitOfWork();
      const registry = persistenceRuntime.getSchemaRegistry();
      const formatProfiles = persistenceRuntime.getFormatProfileRepository();
      if (unitOfWork === null || registry === null || formatProfiles === null) return false;
      activeService = createService({
        appVersion,
        exportSink,
        formatProfiles,
        registry,
        unitOfWork,
      });
      registered = true;
      return true;
    },
  };
};
