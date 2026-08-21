import { createHash, randomUUID } from 'node:crypto';

import { createTransferService } from '@jingxu/application';
import type {
  CompiledSchemaRegistry,
  TransferFilePort,
  TransferUnitOfWorkPort,
} from '@jingxu/application';
import type { AppResultDto } from '@jingxu/contracts';
import { V1_SCHEMA_IDS } from '@jingxu/validation';

import {
  registerTransferIpc,
  type TransferIpcRegistrar,
  type TransferIpcService,
} from '../ipc/transfer-ipc';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';

export interface TransferRuntimeHandles {
  readonly file: TransferFilePort;
  readonly registry: CompiledSchemaRegistry;
  readonly unitOfWork: TransferUnitOfWorkPort;
}

export interface RegisterTransferFeaturesOptions {
  /** 导入 Open Dialog/导出 Save Dialog 文件 sink（E2E 可定路径注入）。 */
  readonly file: TransferFilePort;
  readonly ipcRegistrar: TransferIpcRegistrar;
  readonly newTraceId?: () => string;
  readonly persistenceRuntime: DesktopPersistenceRuntime;
  readonly trustedUrl: string;
}

export interface TransferFeatureRegistration {
  /** Registers the two transfer.* IPC channels exactly once after persistence is writable. */
  ensureRegistered(): boolean;
}

const hashText = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const hashPayload = (value: Readonly<Record<string, unknown>>): string =>
  hashText(JSON.stringify(value));

/** Creates the production transfer service; Schema 校验注入自 Schema Registry（1.2 端口）。 */
export const createProductionTransferService = (
  handles: TransferRuntimeHandles,
): TransferIpcService =>
  createTransferService({
    file: handles.file,
    hashPayload,
    hashText,
    newId: randomUUID,
    now: (): string => new Date().toISOString(),
    unitOfWork: handles.unitOfWork,
    validateBundleSchema: (document) => {
      const result = handles.registry.validate(V1_SCHEMA_IDS.projectTransferBundle, document);
      return result.valid ? { valid: true } : { valid: false };
    },
    validateStoryboardEnvelope: (document) => {
      const result = handles.registry.validate(V1_SCHEMA_IDS.episodeStoryboardExport, document);
      return result.valid ? { valid: true } : { valid: false };
    },
  });

/**
 * Pure transfer composition boundary. Mirrors the Storyboard registration lifecycle:
 * channels are registered up front behind a blocked facade; the real service is
 * injected only after startup reaches READY (writeEnabled).
 */
export const createTransferFeatureRegistration = ({
  file,
  ipcRegistrar,
  newTraceId,
  persistenceRuntime,
  trustedUrl,
}: RegisterTransferFeaturesOptions): TransferFeatureRegistration => {
  let registered = false;
  let activeService: TransferIpcService | null = null;
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
  const facade: TransferIpcService = {
    exportProject: (input, traceId) => activeService?.exportProject(input, traceId) ?? blocked(),
    importProject: (input, traceId) => activeService?.importProject(input, traceId) ?? blocked(),
  };
  registerTransferIpc(
    ipcRegistrar,
    facade,
    { isWriteReady: () => persistenceRuntime.startupService.getStatus().writeEnabled },
    trustedUrl,
    ...(newTraceId === undefined ? [] : [newTraceId]),
  );
  return {
    ensureRegistered: () => {
      if (registered || !persistenceRuntime.startupService.getStatus().writeEnabled) return false;
      const unitOfWork = persistenceRuntime.getTransferUnitOfWork();
      const registry = persistenceRuntime.getSchemaRegistry();
      if (unitOfWork === null || registry === null) return false;
      activeService = createProductionTransferService({ file, registry, unitOfWork });
      registered = true;
      return true;
    },
  };
};
