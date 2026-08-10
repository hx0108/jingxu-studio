import { StartupService, type ProjectUnitOfWorkPort } from '@jingxu/application';
import { SqlitePersistenceRuntimeAdapter, type SqliteConnectionOptions } from '@jingxu/persistence';

export interface DesktopPersistenceRuntime {
  readonly close: () => void;
  readonly getProjectUnitOfWork: () => ProjectUnitOfWorkPort | null;
  readonly startupService: StartupService;
}

export interface CreateDesktopPersistenceRuntimeOptions {
  readonly clock: () => string;
  readonly managedRoot: string;
  readonly migrationDirectory: string;
  readonly sqliteConnectionOptions?: SqliteConnectionOptions;
}

export const createDesktopPersistenceRuntime = async ({
  clock,
  managedRoot,
  migrationDirectory,
  sqliteConnectionOptions,
}: CreateDesktopPersistenceRuntimeOptions): Promise<DesktopPersistenceRuntime> => {
  const adapter = new SqlitePersistenceRuntimeAdapter({
    clock,
    managedRoot,
    migrationDirectory,
    ...(sqliteConnectionOptions === undefined ? {} : { sqliteConnectionOptions }),
  });
  const startupService = new StartupService(adapter);
  await startupService.start();
  return {
    close: () => {
      startupService.close();
    },
    getProjectUnitOfWork: () => adapter.getProjectUnitOfWork(),
    startupService,
  };
};

export const initializePersistenceAfterSingleInstanceLock = async <T>(
  lockAcquired: boolean,
  createRuntime: () => Promise<T>,
): Promise<T | null> => (lockAcquired ? createRuntime() : null);
