import { randomUUID } from 'node:crypto';

import { createEvaluationRulesEngine, createEvaluationService } from '@jingxu/application';
import type {
  CompiledSchemaRegistry,
  EvaluationImportFilePort,
  EvaluationUnitOfWorkPort,
} from '@jingxu/application';
import type { AppResultDto } from '@jingxu/contracts';

import {
  registerEvaluationIpc,
  type EvaluationIpcRegistrar,
  type EvaluationIpcService,
} from '../ipc/evaluation-ipc';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';

export interface EvaluationRuntimeHandles {
  readonly file: EvaluationImportFilePort;
  readonly registry: CompiledSchemaRegistry;
  readonly unitOfWork: EvaluationUnitOfWorkPort;
}

export interface RegisterEvaluationFeaturesOptions {
  /** 导入 Open Dialog 文件 sink（E2E 可定路径注入）。 */
  readonly file: EvaluationImportFilePort;
  readonly ipcRegistrar: EvaluationIpcRegistrar;
  readonly newTraceId?: () => string;
  readonly persistenceRuntime: DesktopPersistenceRuntime;
  readonly trustedUrl: string;
}

export interface EvaluationFeatureRegistration {
  /** Registers the seven evaluation.* IPC channels exactly once after persistence is writable. */
  ensureRegistered(): boolean;
}

/** Creates the production evaluation service; 规则引擎的 Registry 校验自组合根注入（D2）。 */
export const createProductionEvaluationService = (
  handles: EvaluationRuntimeHandles,
): EvaluationIpcService =>
  createEvaluationService({
    file: handles.file,
    newId: randomUUID,
    now: (): string => new Date().toISOString(),
    rules: createEvaluationRulesEngine({
      validateSchema: (schemaId, value) => handles.registry.validate(schemaId, value),
    }),
    unitOfWork: handles.unitOfWork,
  });

/**
 * Pure evaluation composition boundary. Mirrors the Transfer registration lifecycle:
 * channels are registered up front behind a blocked facade; the real service is
 * injected only after startup reaches READY (writeEnabled).
 */
export const createEvaluationFeatureRegistration = ({
  file,
  ipcRegistrar,
  newTraceId,
  persistenceRuntime,
  trustedUrl,
}: RegisterEvaluationFeaturesOptions): EvaluationFeatureRegistration => {
  let registered = false;
  let activeService: EvaluationIpcService | null = null;
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
  const facade: EvaluationIpcService = {
    addAnnotation: (input, traceId) => activeService?.addAnnotation(input, traceId) ?? blocked(),
    createFromEpisode: (input, traceId) =>
      activeService?.createFromEpisode(input, traceId) ?? blocked(),
    createSample: (input, traceId) => activeService?.createSample(input, traceId) ?? blocked(),
    deleteSample: (input, traceId) => activeService?.deleteSample(input, traceId) ?? blocked(),
    getSample: (input, traceId) => activeService?.getSample(input, traceId) ?? blocked(),
    importBatch: (input, traceId) => activeService?.importBatch(input, traceId) ?? blocked(),
    listSamples: (input, traceId) => activeService?.listSamples(input, traceId) ?? blocked(),
  };
  registerEvaluationIpc(
    ipcRegistrar,
    facade,
    { isWriteReady: () => persistenceRuntime.startupService.getStatus().writeEnabled },
    trustedUrl,
    ...(newTraceId === undefined ? [] : [newTraceId]),
  );
  return {
    ensureRegistered: () => {
      if (registered || !persistenceRuntime.startupService.getStatus().writeEnabled) return false;
      const unitOfWork = persistenceRuntime.getEvaluationUnitOfWork();
      const registry = persistenceRuntime.getSchemaRegistry();
      if (unitOfWork === null || registry === null) return false;
      activeService = createProductionEvaluationService({ file, registry, unitOfWork });
      registered = true;
      return true;
    },
  };
};
