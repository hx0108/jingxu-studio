import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SchemaRegistryOperationError } from '@jingxu/application';
import { V1_SCHEMA_LOCKS } from '@jingxu/validation';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SchemaResourceAdapter,
  SchemaResourceAdapterError,
  deriveSchemaResourceDirectory,
} from './schema-resource-adapter';

const resourceNames = V1_SCHEMA_LOCKS.map((lock) => lock.resourceName);
const roots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-schema-resource-'));
  roots.push(root);
  return root;
};

const seedResources = async (root: string): Promise<void> => {
  await Promise.all(
    resourceNames.map((resourceName, index) =>
      writeFile(path.join(root, resourceName), `schema-${String(index)}`, 'utf8'),
    ),
  );
};

const expectSafeFailure = async (
  promise: Promise<unknown>,
  code: 'SCHEMA_MANIFEST_INVALID' | 'SCHEMA_RESOURCE_MISSING',
  forbiddenPath: string,
): Promise<void> => {
  try {
    await promise;
    throw new Error('EXPECTED_SCHEMA_RESOURCE_FAILURE');
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaResourceAdapterError);
    expect(error).toBeInstanceOf(SchemaRegistryOperationError);
    expect(error).toMatchObject({ code });
    expect(error instanceof Error ? error.message : '').not.toContain(forbiddenPath);
  }
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('SchemaResourceAdapter', () => {
  it('固定目录与四个逻辑名—读取成功—返回全新冻结字节快照且无路径字段', async () => {
    const root = await makeRoot();
    await seedResources(root);
    const adapter = new SchemaResourceAdapter({ resourceDirectory: root, resourceNames });

    const first = await adapter.readAllLocked();
    const second = await adapter.readAllLocked();

    expect(first.map((resource) => resource.resourceName)).toEqual(resourceNames);
    expect(
      first.map((resource) => new TextDecoder().decode(Uint8Array.from(resource.bytes))),
    ).toEqual(resourceNames.map((_resourceName, index) => `schema-${String(index)}`));
    expect(Object.isFrozen(first)).toBe(true);
    expect(
      first.every((resource) => Object.isFrozen(resource) && Object.isFrozen(resource.bytes)),
    ).toBe(true);
    expect(first).not.toBe(second);
    expect(first[0]?.bytes).not.toBe(second[0]?.bytes);
    expect(JSON.stringify(first)).not.toContain(root);
  });

  it('缺少锁定资源—读取—返回 SCHEMA_RESOURCE_MISSING 且不泄漏绝对路径', async () => {
    const root = await makeRoot();
    await seedResources(root);
    await rm(path.join(root, resourceNames[0] ?? ''), { force: true });
    const adapter = new SchemaResourceAdapter({ resourceDirectory: root, resourceNames });

    await expectSafeFailure(adapter.readAllLocked(), 'SCHEMA_RESOURCE_MISSING', root);
  });

  it('锁定资源位置是目录项—读取—返回 SCHEMA_MANIFEST_INVALID', async () => {
    const root = await makeRoot();
    await seedResources(root);
    const resourceName = resourceNames[0] ?? '';
    await rm(path.join(root, resourceName), { force: true });
    await mkdir(path.join(root, resourceName));
    const adapter = new SchemaResourceAdapter({ resourceDirectory: root, resourceNames });

    await expectSafeFailure(adapter.readAllLocked(), 'SCHEMA_MANIFEST_INVALID', root);
  });

  it('锁定资源位置是符号链接—读取—返回 SCHEMA_MANIFEST_INVALID 且不读取外部目标', async () => {
    const root = await makeRoot();
    await seedResources(root);
    const outside = await makeRoot();
    const resourceName = resourceNames[0] ?? '';
    await rm(path.join(root, resourceName), { force: true });
    await symlink(outside, path.join(root, resourceName), 'junction');
    const adapter = new SchemaResourceAdapter({ resourceDirectory: root, resourceNames });

    await expectSafeFailure(adapter.readAllLocked(), 'SCHEMA_MANIFEST_INVALID', root);
  });

  it('目录含第五个文件—读取—返回 SCHEMA_MANIFEST_INVALID', async () => {
    const root = await makeRoot();
    await seedResources(root);
    await writeFile(path.join(root, 'Unexpected.schema.json'), '{}', 'utf8');
    const adapter = new SchemaResourceAdapter({ resourceDirectory: root, resourceNames });

    await expectSafeFailure(adapter.readAllLocked(), 'SCHEMA_MANIFEST_INVALID', root);
  });

  it.each(['../outside.json', 'nested/Schema.json', 'nested\\Schema.json', ''])(
    '非法逻辑资源名 %j—构造 Adapter—拒绝路径逃逸',
    (resourceName) => {
      try {
        new SchemaResourceAdapter({
          resourceDirectory: 'C:\\fixed\\schemas',
          resourceNames: [...resourceNames.slice(0, 3), resourceName],
        });
        throw new Error('EXPECTED_SCHEMA_RESOURCE_FAILURE');
      } catch (error) {
        expect(error).toBeInstanceOf(SchemaRegistryOperationError);
        expect(error).toMatchObject({ code: 'SCHEMA_MANIFEST_INVALID' });
      }
    },
  );
});

describe('deriveSchemaResourceDirectory', () => {
  it('开发态—使用 Electron appPath—固定指向 workspace 受控资源副本', () => {
    const appPath = path.resolve('workspace', 'apps', 'desktop');

    expect(
      deriveSchemaResourceDirectory({
        appPath,
        isPackaged: false,
        resourcesPath: path.resolve('ignored-resources'),
      }),
    ).toBe(path.resolve(appPath, '../../packages/validation/resources/schemas/v1'));
  });

  it('打包态—使用 Electron resourcesPath—固定指向 resources/schemas/v1', () => {
    const resourcesPath = path.resolve('packaged', 'resources');

    expect(
      deriveSchemaResourceDirectory({
        appPath: path.resolve('ignored-app'),
        isPackaged: true,
        resourcesPath,
      }),
    ).toBe(path.join(resourcesPath, 'schemas', 'v1'));
  });
});
