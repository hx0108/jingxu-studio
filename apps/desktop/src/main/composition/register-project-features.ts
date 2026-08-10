import type { DesktopPersistenceRuntime } from './create-persistence-runtime';
import { createDesktopProjectService } from './create-project-service';
import { registerProjectIpc, type ProjectIpcRegistrar } from '../ipc/project-ipc';

export interface RegisterProjectFeaturesOptions {
  readonly ipcRegistrar: ProjectIpcRegistrar;
  readonly managedRoot: string;
  readonly persistenceRuntime: DesktopPersistenceRuntime;
  readonly trustedUrl: string;
}

export interface ProjectFeatureRegistration {
  /** Registers once after READY; returns true only for the call that performed registration. */
  ensureRegistered(): boolean;
}

/**
 * Defers construction of writable Project capabilities until the startup audit reaches READY.
 * Runtime retry/restore may call this repeatedly; the six handlers are registered exactly once.
 */
export const createProjectFeatureRegistration = ({
  ipcRegistrar,
  managedRoot,
  persistenceRuntime,
  trustedUrl,
}: RegisterProjectFeaturesOptions): ProjectFeatureRegistration => {
  let registered = false;

  return {
    ensureRegistered: () => {
      if (registered || !persistenceRuntime.startupService.getStatus().writeEnabled) return false;
      const unitOfWork = persistenceRuntime.getProjectUnitOfWork();
      if (unitOfWork === null) return false;

      const service = createDesktopProjectService({ managedRoot, unitOfWork });
      registerProjectIpc(
        ipcRegistrar,
        service,
        {
          isWriteReady: () => persistenceRuntime.startupService.getStatus().writeEnabled,
        },
        trustedUrl,
      );
      registered = true;
      return true;
    },
  };
};
