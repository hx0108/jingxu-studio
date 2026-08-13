import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { SchemaRegistryOperationError } from '@jingxu/application';
import { V1_SCHEMA_LOCKS } from '@jingxu/validation';
import { describe, expect, it } from 'vitest';

import { SchemaRegistryAdapter } from './schema-registry-adapter';

const schemaRoot = path.resolve(
  import.meta.dirname,
  '../../../../../packages/validation/resources/schemas/v1',
);

const readLockedResources = async () =>
  Promise.all(
    V1_SCHEMA_LOCKS.map(async (lock) => ({
      bytes: Array.from(await readFile(path.join(schemaRoot, lock.resourceName))),
      resourceName: lock.resourceName,
    })),
  );

describe('SchemaRegistryAdapter', () => {
  it('四份锁定资源完整—编译后提交发布—仅一次暴露完整 Registry', async () => {
    const adapter = new SchemaRegistryAdapter();
    const resources = await readLockedResources();

    expect(adapter.getPublished()).toBeNull();
    const compiled = await adapter.verifyAndCompile(V1_SCHEMA_LOCKS, resources);
    expect(adapter.getPublished()).toBeNull();
    expect(compiled.schemaIds).toEqual(V1_SCHEMA_LOCKS.map((lock) => lock.schemaId));

    adapter.publish(compiled);

    expect(adapter.getPublished()).toBe(compiled);
  });

  it('锁清单与构建静态事实不一致—编译—稳定拒绝且保持未发布', async () => {
    const adapter = new SchemaRegistryAdapter();
    const resources = await readLockedResources();
    const drifted = V1_SCHEMA_LOCKS.map((lock, index) =>
      index === 0 ? { ...lock, semanticVersion: '9.9.9' } : lock,
    );

    await expect(adapter.verifyAndCompile(drifted, resources)).rejects.toMatchObject({
      code: 'SCHEMA_MANIFEST_INVALID',
    });
    expect(adapter.getPublished()).toBeNull();
  });

  it('资源 hash 漂移—编译—归一化为安全 Application 错误', async () => {
    const adapter = new SchemaRegistryAdapter();
    const resources = await readLockedResources();
    const drifted = resources.map((resource, index) =>
      index === 0 ? { ...resource, bytes: [...resource.bytes, 10] } : resource,
    );

    try {
      await adapter.verifyAndCompile(V1_SCHEMA_LOCKS, drifted);
      throw new Error('EXPECTED_SCHEMA_REGISTRY_FAILURE');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaRegistryOperationError);
      expect(error).toMatchObject({ code: 'SCHEMA_HASH_MISMATCH' });
      expect(error instanceof Error ? error.message : '').not.toContain(schemaRoot);
    }
  });
});
