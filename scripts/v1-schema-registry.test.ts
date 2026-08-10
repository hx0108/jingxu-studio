import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { V1_SCHEMA_IDS, V1_SCHEMA_LOCKS, buildSchemaRegistry } from '@jingxu/validation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  LockedSchemaResource,
  SchemaRegistryBuildError,
  V1SchemaLock,
} from '@jingxu/validation';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const resourceRoot = path.join(
  repositoryRoot,
  'packages',
  'validation',
  'resources',
  'schemas',
  'v1',
);

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const readLockedResources = async (): Promise<readonly LockedSchemaResource[]> =>
  Promise.all(
    V1_SCHEMA_LOCKS.map(async (lock) => ({
      resourceName: lock.resourceName,
      bytes: Uint8Array.from(await readFile(path.join(resourceRoot, lock.resourceName))),
    })),
  );

const replaceDocument = async (
  resourceName: string,
  mutate: (document: Record<string, unknown>) => void,
): Promise<{
  readonly locks: readonly V1SchemaLock[];
  readonly resources: readonly LockedSchemaResource[];
}> => {
  const resources = await readLockedResources();
  const original = resources.find((resource) => resource.resourceName === resourceName);
  if (original === undefined) throw new Error('Test resource is missing.');
  const document = JSON.parse(new TextDecoder().decode(original.bytes)) as Record<string, unknown>;
  mutate(document);
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  return {
    locks: V1_SCHEMA_LOCKS.map((lock) =>
      lock.resourceName === resourceName ? { ...lock, sha256: sha256(bytes) } : lock,
    ),
    resources: resources.map((resource) =>
      resource.resourceName === resourceName ? { ...resource, bytes } : resource,
    ),
  };
};

const expectBuildCode = async (
  promise: Promise<unknown>,
  code: SchemaRegistryBuildError['code'],
): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ code });
  await expect(promise).rejects.not.toThrow(/C:\\|do-not-leak|\n\s+at /u);
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('V1 Schema Registry 离线构建', () => {
  it('四份受控资源—设备断网—一次发布四个可查询校验器', async () => {
    const fetchGuard = vi.fn(() => Promise.reject(new Error('network must not be used')));
    vi.stubGlobal('fetch', fetchGuard);
    const registry = await buildSchemaRegistry(V1_SCHEMA_LOCKS, await readLockedResources());

    expect(registry.schemaIds).toEqual(Object.values(V1_SCHEMA_IDS));
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  it('资源集合缺失—构建 Registry—返回 SCHEMA_RESOURCE_MISSING 且不发布部分结果', async () => {
    const resources = await readLockedResources();
    await expectBuildCode(
      buildSchemaRegistry(V1_SCHEMA_LOCKS, resources.slice(1)),
      'SCHEMA_RESOURCE_MISSING',
    );
  });

  it.each([
    ['非法 UTF-8', Uint8Array.from([0xc3, 0x28])],
    ['截断 JSON', new TextEncoder().encode('{"$id":')],
  ])('%s—解析资源—返回 SCHEMA_RESOURCE_INVALID_JSON', async (_label, bytes) => {
    const resourceName = V1_SCHEMA_LOCKS[0]?.resourceName ?? 'missing';
    const resources = (await readLockedResources()).map((resource) =>
      resource.resourceName === resourceName ? { ...resource, bytes } : resource,
    );
    const locks = V1_SCHEMA_LOCKS.map((lock) =>
      lock.resourceName === resourceName ? { ...lock, sha256: sha256(bytes) } : lock,
    );
    await expectBuildCode(buildSchemaRegistry(locks, resources), 'SCHEMA_RESOURCE_INVALID_JSON');
  });

  it('合法 JSON 字节漂移—核对 hash—返回 SCHEMA_HASH_MISMATCH', async () => {
    const resources = await readLockedResources();
    const first = resources[0];
    if (first === undefined) throw new Error('Test resource is missing.');
    const changed = new TextEncoder().encode(`${new TextDecoder().decode(first.bytes).trimEnd()} `);
    await expectBuildCode(
      buildSchemaRegistry(V1_SCHEMA_LOCKS, [{ ...first, bytes: changed }, ...resources.slice(1)]),
      'SCHEMA_HASH_MISMATCH',
    );
  });

  it.each([
    [
      'ID 不一致',
      (document: Record<string, unknown>) => {
        document.$id = 'https://jingxu.studio/schemas/wrong/1.0.0';
      },
      'SCHEMA_ID_MISMATCH',
    ],
    [
      'Draft 不一致',
      (document: Record<string, unknown>) => {
        document.$schema = 'https://json-schema.org/draft/2019-09/schema';
      },
      'SCHEMA_DRAFT_MISMATCH',
    ],
    [
      '版本不一致',
      (document: Record<string, unknown>) => {
        const properties = document.properties as Record<string, Record<string, unknown>>;
        const schemaVersion = properties.schema_version;
        if (schemaVersion !== undefined) schemaVersion.const = '9.9.9';
      },
      'SCHEMA_VERSION_MISMATCH',
    ],
  ] as const)('%s—核对 Schema 身份—返回对应稳定错误码', async (_label, mutate, expectedCode) => {
    const candidate = await replaceDocument('ScriptStageOutput.schema.json', mutate);
    await expectBuildCode(buildSchemaRegistry(candidate.locks, candidate.resources), expectedCode);
  });

  it('重复文档 ID—核对完整集合—返回 SCHEMA_MANIFEST_INVALID', async () => {
    const candidate = await replaceDocument('ShotContract.schema.json', (document) => {
      document.$id = V1_SCHEMA_IDS.scriptStageOutput;
    });
    await expectBuildCode(
      buildSchemaRegistry(candidate.locks, candidate.resources),
      'SCHEMA_MANIFEST_INVALID',
    );
  });

  it('未知外部引用—闭包核验—返回 SCHEMA_REFERENCE_UNRESOLVED 且零网络', async () => {
    const fetchGuard = vi.fn(() => Promise.reject(new Error('network must not be used')));
    vi.stubGlobal('fetch', fetchGuard);
    const candidate = await replaceDocument('EpisodeStoryboardExport.schema.json', (document) => {
      const properties = document.properties as Record<string, Record<string, unknown>>;
      const shots = properties.shot_contracts;
      if (shots !== undefined) {
        shots.items = { $ref: 'https://jingxu.studio/schemas/shot-contract/9.9.9' };
      }
    });

    await expectBuildCode(
      buildSchemaRegistry(candidate.locks, candidate.resources),
      'SCHEMA_REFERENCE_UNRESOLVED',
    );
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  it('锁和资源注册顺序变化—构建 Registry—结果保持一致', async () => {
    const resources = await readLockedResources();
    const registry = await buildSchemaRegistry(
      [...V1_SCHEMA_LOCKS].reverse(),
      [...resources].reverse(),
    );
    expect(registry.schemaIds).toEqual(Object.values(V1_SCHEMA_IDS));
  });

  it('非法 Schema 关键字—同步编译—返回 SCHEMA_COMPILE_FAILED', async () => {
    const candidate = await replaceDocument('ScriptStageOutput.schema.json', (document) => {
      document.type = 42;
    });
    await expectBuildCode(
      buildSchemaRegistry(candidate.locks, candidate.resources),
      'SCHEMA_COMPILE_FAILED',
    );
  });

  it('首次编译失败—修复同一资源后重试—使用干净 Ajv 并完整发布', async () => {
    const broken = await replaceDocument('ScriptStageOutput.schema.json', (document) => {
      document.type = 42;
    });
    await expectBuildCode(
      buildSchemaRegistry(broken.locks, broken.resources),
      'SCHEMA_COMPILE_FAILED',
    );

    const registry = await buildSchemaRegistry(V1_SCHEMA_LOCKS, await readLockedResources());
    expect(registry.schemaIds).toEqual(Object.values(V1_SCHEMA_IDS));
  });
});

describe('V1 Schema Registry 确定性校验', () => {
  it('合法对象—按完整 ID 校验—返回有效且不修改输入', async () => {
    const registry = await buildSchemaRegistry(V1_SCHEMA_LOCKS, await readLockedResources());
    const input = {
      schema_version: '1.0.0',
      project_id: 'project_demo',
      episode_id: null,
      source_invocation_id: 'invocation_demo',
      stage: 'CONCEPT',
      data: {
        title: '标题',
        genre: '奇幻',
        target_audience: '青年',
        core_conflict: '主人公必须在真相与家人之间选择。',
        theme: '选择与代价',
        synopsis: '一段完整但虚构的故事梗概。',
      },
    };
    const before = structuredClone(input);

    expect(registry.validate(V1_SCHEMA_IDS.scriptStageOutput, input)).toEqual({
      valid: true,
      issues: [],
    });
    expect(input).toEqual(before);
  });

  it('大量非法字段—重复校验—问题有界并按稳定三元组排序', async () => {
    const registry = await buildSchemaRegistry(V1_SCHEMA_LOCKS, await readLockedResources());
    const extras = Object.fromEntries(
      Array.from({ length: 120 }, (_value, index) => [
        `extra_${String(index).padStart(3, '0')}`,
        true,
      ]),
    );
    const input = {
      schema_version: '1.0.0',
      project_id: 'project_demo',
      episode_id: null,
      source_invocation_id: 'invocation_demo',
      stage: 'CONCEPT',
      data: extras,
    };
    const first = registry.validate(V1_SCHEMA_IDS.scriptStageOutput, input);
    const second = registry.validate(V1_SCHEMA_IDS.scriptStageOutput, input);

    expect(first).toEqual(second);
    expect(first.valid).toBe(false);
    expect(first.issues.length).toBeGreaterThan(0);
    expect(first.issues.length).toBeLessThanOrEqual(50);
    const issueKeys = first.issues.map(
      (issue) => `${issue.instancePath}\u0000${issue.keyword}\u0000${issue.messageCode}`,
    );
    expect(issueKeys).toEqual([...issueKeys].sort());
  });

  it('未知 Schema ID—请求校验—返回 SCHEMA_ID_NOT_REGISTERED', async () => {
    const registry = await buildSchemaRegistry(V1_SCHEMA_LOCKS, await readLockedResources());
    expect(() => registry.validate('https://jingxu.studio/schemas/unknown/1.0.0', {})).toThrow(
      expect.objectContaining({ code: 'SCHEMA_ID_NOT_REGISTERED' }),
    );
  });
});
