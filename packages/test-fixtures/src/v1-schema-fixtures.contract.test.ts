import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { V1_SCHEMA_LOCKS, buildSchemaRegistry } from '@jingxu/validation';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { V1_SCHEMA_FIXTURE_CASES } from './v1-schema-fixture-cases';

import type { LockedSchemaResource, SchemaRegistry } from '@jingxu/validation';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const schemaResourceRoot = path.join(
  repositoryRoot,
  'packages',
  'validation',
  'resources',
  'schemas',
  'v1',
);
const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'v1');

let registry: SchemaRegistry;

beforeAll(async () => {
  const resources: readonly LockedSchemaResource[] = await Promise.all(
    V1_SCHEMA_LOCKS.map(async (lock) => ({
      resourceName: lock.resourceName,
      bytes: Uint8Array.from(await readFile(path.join(schemaResourceRoot, lock.resourceName))),
    })),
  );
  registry = await buildSchemaRegistry(V1_SCHEMA_LOCKS, resources);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('四份正式 Schema 的合法与单错误 Fixture', () => {
  it('八份 Fixture—断网全量校验—4 个合法通过且 4 个非法各命中唯一声明错误', async () => {
    const fetchGuard = vi.fn(() => Promise.reject(new Error('network must not be used')));
    vi.stubGlobal('fetch', fetchGuard);

    for (const fixtureCase of V1_SCHEMA_FIXTURE_CASES) {
      const fixture: unknown = JSON.parse(
        await readFile(path.join(fixtureRoot, fixtureCase.fixtureName), 'utf8'),
      );
      const result = registry.validate(fixtureCase.schemaId, fixture);
      expect(result.valid, fixtureCase.fixtureName).toBe(fixtureCase.expectedValid);
      if (!fixtureCase.expectedValid && !result.valid) {
        expect(result.issues, fixtureCase.fixtureName).toEqual([
          {
            instancePath: fixtureCase.expectedInstancePath,
            keyword: fixtureCase.expectedKeyword,
            messageCode: fixtureCase.expectedMessageCode,
          },
        ]);
      }
    }

    expect(fetchGuard).not.toHaveBeenCalled();
  });
});
