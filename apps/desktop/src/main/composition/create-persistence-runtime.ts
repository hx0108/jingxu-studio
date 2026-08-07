import { StartupService } from '@jingxu/application';
import { SqlitePersistenceRuntimeAdapter } from '@jingxu/persistence';

export interface DesktopPersistenceRuntime {
  readonly close: () => void;
  readonly startupService: StartupService;
}

export interface CreateDesktopPersistenceRuntimeOptions {
  readonly clock: () => string;
  readonly managedRoot: string;
  readonly migrationDirectory: string;
}

export const createDesktopPersistenceRuntime = async ({
  clock,
  managedRoot,
  migrationDirectory,
}: CreateDesktopPersistenceRuntimeOptions): Promise<DesktopPersistenceRuntime> => {
  const adapter = new SqlitePersistenceRuntimeAdapter({
    clock,
    managedRoot,
    migrationDirectory,
  });
  const startupService = new StartupService(adapter);
  await startupService.start();
  return {
    close: () => {
      startupService.close();
    },
    startupService,
  };
};

export const initializePersistenceAfterSingleInstanceLock = async <T>(
  lockAcquired: boolean,
  createRuntime: () => Promise<T>,
): Promise<T | null> => (lockAcquired ? createRuntime() : null);
