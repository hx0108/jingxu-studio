import type { AppResultDto, ProjectDetailDto, ProjectListResultDto } from '@jingxu/contracts';

import type { DesktopPersistenceRuntime } from './create-persistence-runtime';
import { createDesktopProjectService } from './create-project-service';
import {
  registerProjectIpc,
  type ProjectIpcRegistrar,
  type ProjectIpcService,
} from '../ipc/project-ipc';

export interface RegisterProjectFeaturesOptions {
  readonly ipcRegistrar: ProjectIpcRegistrar;
  readonly managedRoot: string;
  readonly persistenceRuntime: DesktopPersistenceRuntime;
  readonly trustedUrl: string;
}

export interface ProjectFeatureRegistration {
  /** Activates the real service once after READY; returns true only for that activation call. */
  ensureRegistered(): boolean;
}

/**
 * Registers the six safe IPC boundaries immediately, but defers construction of writable Project
 * capabilities until the startup audit reaches READY. Runtime retry/restore may call
 * `ensureRegistered` repeatedly without replacing handlers or constructing a service in fault mode.
 */
export const createProjectFeatureRegistration = ({
  ipcRegistrar,
  managedRoot,
  persistenceRuntime,
  trustedUrl,
}: RegisterProjectFeaturesOptions): ProjectFeatureRegistration => {
  let registered = false;
  let service: ProjectIpcService | null = null;

  const startupBlocked = <T>(traceId: string): Promise<AppResultDto<T>> =>
    Promise.resolve({
      ok: false,
      error: {
        code: 'STARTUP_WRITE_BLOCKED',
        message: '应用尚未进入可写状态',
        retryable: true,
        userAction: '请先处理启动故障后重试',
        fieldErrors: null,
        traceId,
      },
    });

  const serviceFacade: ProjectIpcService = {
    list: (input, traceId): Promise<AppResultDto<ProjectListResultDto>> =>
      service?.list(input, traceId) ?? startupBlocked(traceId),
    get: (input, traceId): Promise<AppResultDto<ProjectDetailDto>> =>
      service?.get(input, traceId) ?? startupBlocked(traceId),
    create: (input, traceId): Promise<AppResultDto<ProjectDetailDto>> =>
      service?.create(input, traceId) ?? startupBlocked(traceId),
    update: (input, traceId): Promise<AppResultDto<ProjectDetailDto>> =>
      service?.update(input, traceId) ?? startupBlocked(traceId),
    delete: (input, traceId): Promise<AppResultDto<ProjectDetailDto>> =>
      service?.delete(input, traceId) ?? startupBlocked(traceId),
    restore: (input, traceId): Promise<AppResultDto<ProjectDetailDto>> =>
      service?.restore(input, traceId) ?? startupBlocked(traceId),
  };

  registerProjectIpc(
    ipcRegistrar,
    serviceFacade,
    {
      isWriteReady: () => persistenceRuntime.startupService.getStatus().writeEnabled,
    },
    trustedUrl,
  );

  return {
    ensureRegistered: () => {
      if (registered || !persistenceRuntime.startupService.getStatus().writeEnabled) return false;
      const unitOfWork = persistenceRuntime.getProjectUnitOfWork();
      if (unitOfWork === null) return false;

      service = createDesktopProjectService({ managedRoot, unitOfWork });
      registered = true;
      return true;
    },
  };
};
