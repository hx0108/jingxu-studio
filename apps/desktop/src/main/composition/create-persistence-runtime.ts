import {
  applyMigrations,
  createManagedDirectories,
  createManagedPaths,
  initializeSqliteDatabase,
  loadMigrationSet,
  SqliteConnectionManager,
} from '@jingxu/persistence';

export interface DesktopPersistenceRuntime {
  readonly close: () => void;
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
  const paths = createManagedPaths(managedRoot);
  await createManagedDirectories(paths);
  const manager = new SqliteConnectionManager(paths.databasePath);

  try {
    const migrations = await loadMigrationSet(migrationDirectory);
    await initializeSqliteDatabase(manager, (connection) => {
      applyMigrations(connection, migrations, clock);
    });
    return {
      close: () => {
        manager.close();
      },
    };
  } catch (error) {
    manager.close();
    throw error;
  }
};

export const initializePersistenceAfterSingleInstanceLock = async <T>(
  lockAcquired: boolean,
  createRuntime: () => Promise<T>,
): Promise<T | null> => (lockAcquired ? createRuntime() : null);
