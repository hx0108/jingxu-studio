import type {
  CompiledSchemaRegistry,
  LockedSchemaResource,
  SchemaLockRecord,
  SchemaManifestRecord,
  SchemaManifestUnitOfWorkPort,
  SchemaRegistryCheckResult,
  SchemaRegistryPort,
  SchemaResourcePort,
  SchemaStartupErrorCode,
  SchemaStartupFailure,
} from '../ports/schema-registry';
import { SchemaRegistryOperationError } from '../ports/schema-registry';

export interface SchemaRegistryStartupDependencies {
  readonly locks: readonly SchemaLockRecord[];
  readonly manifestUnitOfWork: SchemaManifestUnitOfWorkPort;
  readonly registry: SchemaRegistryPort;
  readonly resources: SchemaResourcePort;
}

const toManifest = (locks: readonly SchemaLockRecord[]): readonly SchemaManifestRecord[] =>
  locks
    .map((lock) => ({
      enabled: true,
      resourceName: lock.resourceName,
      schemaId: lock.schemaId,
      semanticVersion: lock.semanticVersion,
      sha256: lock.sha256,
    }))
    .sort((left, right) => left.schemaId.localeCompare(right.schemaId));

const manifestsMatch = (
  expected: readonly SchemaManifestRecord[],
  actual: readonly SchemaManifestRecord[],
): boolean => {
  if (expected.length !== actual.length) return false;
  const sortedActual = [...actual].sort((left, right) =>
    left.schemaId.localeCompare(right.schemaId),
  );
  return expected.every((record, index) => {
    const candidate = sortedActual[index];
    return (
      candidate?.enabled === record.enabled &&
      candidate.resourceName === record.resourceName &&
      candidate.schemaId === record.schemaId &&
      candidate.semanticVersion === record.semanticVersion &&
      candidate.sha256 === record.sha256
    );
  });
};

const toFailure = (error: unknown, fallbackCode: SchemaStartupErrorCode): SchemaStartupFailure => {
  const normalized =
    error instanceof SchemaRegistryOperationError
      ? error
      : new SchemaRegistryOperationError(fallbackCode);
  return {
    allowedActions: ['RETRY'],
    errorCode: normalized.code,
    phase: 'SCHEMA_REGISTRY',
    retryable: true,
    summary: normalized.message,
  };
};

/** 编排离线资源核验、manifest 短事务和 Registry 原子发布。 */
export class SchemaRegistryStartupService {
  readonly #dependencies: SchemaRegistryStartupDependencies;

  public constructor(dependencies: SchemaRegistryStartupDependencies) {
    this.#dependencies = dependencies;
  }

  public async prepare(): Promise<SchemaRegistryCheckResult> {
    let resources: readonly LockedSchemaResource[];
    try {
      resources = await this.#dependencies.resources.readAllLocked();
    } catch (error) {
      return { failure: toFailure(error, 'SCHEMA_RESOURCE_MISSING'), ok: false };
    }

    let compiled: CompiledSchemaRegistry;
    try {
      compiled = await this.#dependencies.registry.verifyAndCompile(
        this.#dependencies.locks,
        resources,
      );
    } catch (error) {
      return { failure: toFailure(error, 'SCHEMA_COMPILE_FAILED'), ok: false };
    }

    const expectedManifest = toManifest(this.#dependencies.locks);
    try {
      await this.#dependencies.manifestUnitOfWork.run(async (repository) => {
        await repository.replaceAll(expectedManifest);
        const committedCandidate = await repository.findEnabled();
        if (!manifestsMatch(expectedManifest, committedCandidate)) {
          throw new SchemaRegistryOperationError('SCHEMA_EVIDENCE_WRITE_FAILED');
        }
      });
    } catch (error) {
      return { failure: toFailure(error, 'SCHEMA_EVIDENCE_WRITE_FAILED'), ok: false };
    }

    try {
      this.#dependencies.registry.publish(compiled);
    } catch (error) {
      return { failure: toFailure(error, 'SCHEMA_COMPILE_FAILED'), ok: false };
    }

    return { manifest: expectedManifest.map((record) => ({ ...record })), ok: true };
  }
}
