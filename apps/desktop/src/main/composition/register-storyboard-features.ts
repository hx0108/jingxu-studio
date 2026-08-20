import { createHash, randomUUID } from 'node:crypto';

import { createShotEditLockService } from '@jingxu/application';
import type {
  CompiledSchemaRegistry,
  ScriptUnitOfWorkPort,
  ShotEditLockSummary,
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
  readonly registry: CompiledSchemaRegistry;
  readonly unitOfWork: ScriptUnitOfWorkPort;
}

export interface RegisterStoryboardFeaturesOptions {
  readonly createService: (handles: StoryboardRuntimeHandles) => StoryboardIpcService;
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

const hashText = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const hashPayload = (value: Readonly<Record<string, unknown>>): string =>
  hashText(JSON.stringify(value));

/** Creates the production shot edit/lock service; ShotContract 1.1.0 校验注入自 Schema Registry。 */
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
            details: result.issues.map((issue) => `${issue.instancePath}:${issue.keyword}`),
            valid: false,
          };
    },
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
    lockShot: (input, traceId) => adapt(service.lockShot(input, traceId)),
    unlockShot: (input, traceId) => adapt(service.unlockShot(input, traceId)),
  };
};

/**
 * Pure storyboard composition boundary. Mirrors the Script registration lifecycle:
 * channels are registered up front behind a blocked facade; the real service is
 * injected only after startup reaches READY (writeEnabled).
 */
export const createStoryboardFeatureRegistration = ({
  createService,
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
    lockShot: (input, traceId) => activeService?.lockShot(input, traceId) ?? blocked(),
    unlockShot: (input, traceId) => activeService?.unlockShot(input, traceId) ?? blocked(),
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
      if (unitOfWork === null || registry === null) return false;
      activeService = createService({ registry, unitOfWork });
      registered = true;
      return true;
    },
  };
};
