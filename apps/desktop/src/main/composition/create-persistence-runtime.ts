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
  FormatProfileRepository,
  JobRepositoryPort,
  JobUnitOfWorkPort,
  MediaUnitOfWorkPort,
  ProjectUnitOfWorkPort,
  ProviderProfileRepositoryPort,
  ProviderUnitOfWorkPort,
  SchemaManifestRepositoryPort,
  SchemaManifestUnitOfWorkPort,
  ScriptUnitOfWorkPort,
  ScriptWorkspaceQueryPort,
  TransferUnitOfWorkPort,
} from '@jingxu/application';

export interface DesktopPersistenceRuntime {
  readonly close: () => void;
  readonly getFormatProfileRepository: () => FormatProfileRepository | null;
  readonly getJobUnitOfWork: () => JobUnitOfWorkPort | null;
  readonly getJobRepository: () => JobRepositoryPort | null;
  readonly getMediaUnitOfWork: () => MediaUnitOfWorkPort | null;
  readonly getProjectUnitOfWork: () => ProjectUnitOfWorkPort | null;
  readonly getProviderUnitOfWork: () => ProviderUnitOfWorkPort | null;
  readonly getProviderProfileRepository: () => ProviderProfileRepositoryPort | null;
  readonly getSchemaRegistry: () => CompiledSchemaRegistry | null;
  readonly getScriptUnitOfWork: () => ScriptUnitOfWorkPort | null;
  readonly getScriptWorkspaceQuery: () => ScriptWorkspaceQueryPort | null;
  readonly getTransferUnitOfWork: () => TransferUnitOfWorkPort | null;
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
    getFormatProfileRepository: () => adapter.getFormatProfileRepository(),
    getJobUnitOfWork: () => adapter.getJobUnitOfWork(),
    getJobRepository: () => adapter.getJobRepository(),
    getMediaUnitOfWork: () => adapter.getMediaUnitOfWork(),
    getProjectUnitOfWork: () => adapter.getProjectUnitOfWork(),
    getProviderUnitOfWork: () => adapter.getProviderUnitOfWork(),
    getProviderProfileRepository: () => adapter.getProviderProfileRepository(),
    getSchemaRegistry: () => registry.getPublished(),
    getScriptUnitOfWork: () => adapter.getScriptUnitOfWork(),
    getScriptWorkspaceQuery: () => adapter.getScriptWorkspaceQuery(),
    getTransferUnitOfWork: () => adapter.getTransferUnitOfWork(),
    startupService,
  };
};

export const initializePersistenceAfterSingleInstanceLock = async <T>(
  lockAcquired: boolean,
  createRuntime: () => Promise<T>,
): Promise<T | null> => (lockAcquired ? createRuntime() : null);
