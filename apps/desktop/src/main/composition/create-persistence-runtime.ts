import {
  SchemaRegistryOperationError,
  SchemaRegistryStartupService,
  StartupService,
} from '@jingxu/application';
import { SqlitePersistenceRuntimeAdapter, type SqliteConnectionOptions } from '@jingxu/persistence';
import { V1_SCHEMA_LOCKS } from '@jingxu/validation';

import { SchemaRegistryAdapter } from '../adapters/schema-registry-adapter';
import { SchemaResourceAdapter } from '../adapters/schema-resource-adapter';

import type {
  CompiledSchemaRegistry,
  ProjectUnitOfWorkPort,
  SchemaManifestRepositoryPort,
  SchemaManifestUnitOfWorkPort,
} from '@jingxu/application';

export interface DesktopPersistenceRuntime {
  readonly close: () => void;
  readonly getProjectUnitOfWork: () => ProjectUnitOfWorkPort | null;
  readonly getSchemaRegistry: () => CompiledSchemaRegistry | null;
  readonly startupService: StartupService;
}

export interface CreateDesktopPersistenceRuntimeOptions {
  readonly clock: () => string;
  readonly managedRoot: string;
  readonly migrationDirectory: string;
  readonly schemaResourceDirectory: string;
  readonly sqliteConnectionOptions?: SqliteConnectionOptions;
}

export const createDesktopPersistenceRuntime = async ({
  clock,
  managedRoot,
  migrationDirectory,
  schemaResourceDirectory,
  sqliteConnectionOptions,
}: CreateDesktopPersistenceRuntimeOptions): Promise<DesktopPersistenceRuntime> => {
  const adapter = new SqlitePersistenceRuntimeAdapter({
    clock,
    managedRoot,
    migrationDirectory,
    ...(sqliteConnectionOptions === undefined ? {} : { sqliteConnectionOptions }),
  });
  const registry = new SchemaRegistryAdapter();
  const resources = new SchemaResourceAdapter({
    resourceDirectory: schemaResourceDirectory,
    resourceNames: V1_SCHEMA_LOCKS.map((lock) => lock.resourceName),
  });
  const manifestUnitOfWork: SchemaManifestUnitOfWorkPort = {
    run: <T>(work: (repository: SchemaManifestRepositoryPort) => Promise<T>): Promise<T> => {
      const unitOfWork = adapter.getSchemaManifestUnitOfWork();
      if (unitOfWork === null) {
        return Promise.reject(new SchemaRegistryOperationError('SCHEMA_EVIDENCE_WRITE_FAILED'));
      }
      return unitOfWork.run(work);
    },
  };
  const schemaStartupService = new SchemaRegistryStartupService({
    locks: V1_SCHEMA_LOCKS,
    manifestUnitOfWork,
    registry,
    resources,
  });
  const startupService = new StartupService(adapter, schemaStartupService);
  await startupService.start();
  return {
    close: () => {
      startupService.close();
      registry.close();
    },
    getProjectUnitOfWork: () => adapter.getProjectUnitOfWork(),
    getSchemaRegistry: () => registry.getPublished(),
    startupService,
  };
};

export const initializePersistenceAfterSingleInstanceLock = async <T>(
  lockAcquired: boolean,
  createRuntime: () => Promise<T>,
): Promise<T | null> => (lockAcquired ? createRuntime() : null);
