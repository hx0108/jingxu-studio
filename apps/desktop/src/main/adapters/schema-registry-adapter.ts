import { SchemaRegistryOperationError } from '@jingxu/application';
import { SchemaRegistryBuildError, V1_SCHEMA_LOCKS, buildSchemaRegistry } from '@jingxu/validation';

import type {
  CompiledSchemaRegistry,
  LockedSchemaResource,
  SchemaLockRecord,
  SchemaRegistryPort,
} from '@jingxu/application';

const locksMatchCurrentBuild = (locks: readonly SchemaLockRecord[]): boolean =>
  locks.length === V1_SCHEMA_LOCKS.length &&
  locks.every((lock, index) => {
    const expected = V1_SCHEMA_LOCKS[index];
    return (
      lock.draft === expected?.draft &&
      lock.resourceName === expected.resourceName &&
      lock.schemaId === expected.schemaId &&
      lock.semanticVersion === expected.semanticVersion &&
      lock.sha256 === expected.sha256
    );
  });

/** Owns the process-local publication pointer while Validation performs deterministic compilation. */
export class SchemaRegistryAdapter implements SchemaRegistryPort {
  #published: CompiledSchemaRegistry | null = null;

  public close(): void {
    this.#published = null;
  }

  public getPublished(): CompiledSchemaRegistry | null {
    return this.#published;
  }

  public publish(registry: CompiledSchemaRegistry): void {
    this.#published = registry;
  }

  public async verifyAndCompile(
    locks: readonly SchemaLockRecord[],
    resources: readonly LockedSchemaResource[],
  ): Promise<CompiledSchemaRegistry> {
    if (!locksMatchCurrentBuild(locks)) {
      throw new SchemaRegistryOperationError('SCHEMA_MANIFEST_INVALID');
    }

    try {
      return await buildSchemaRegistry(
        V1_SCHEMA_LOCKS,
        resources.map((resource) => ({
          bytes: Uint8Array.from(resource.bytes),
          resourceName: resource.resourceName,
        })),
      );
    } catch (error) {
      if (error instanceof SchemaRegistryBuildError) {
        throw new SchemaRegistryOperationError(error.code);
      }
      throw new SchemaRegistryOperationError('SCHEMA_COMPILE_FAILED');
    }
  }
}
