import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createDesktopPersistenceRuntime,
  initializePersistenceAfterSingleInstanceLock,
} from './create-persistence-runtime';

const MIGRATION_DIRECTORY = path.resolve(
  import.meta.dirname,
  '../../../../../packages/persistence/resources/migrations',
);
const SCHEMA_RESOURCE_DIRECTORY = path.resolve(
  import.meta.dirname,
  '../../../../../packages/validation/resources/schemas/v1',
);
const FIXED_TIME = '2026-08-08T00:00:00.000Z';

describe('Main Persistence Composition Root', () => {
  it('未取得 single-instance lock—初始化持久化—不创建数据库运行时', async () => {
    const createRuntime = vi.fn();

    await expect(
      initializePersistenceAfterSingleInstanceLock(false, createRuntime),
    ).resolves.toBeNull();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('取得 single-instance lock—注入测试根—创建唯一连接并完成初始 migration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-composition-test-'));
    let runtime: Awaited<ReturnType<typeof createDesktopPersistenceRuntime>> | null = null;
    try {
      runtime = await initializePersistenceAfterSingleInstanceLock(true, () =>
        createDesktopPersistenceRuntime({
          clock: () => FIXED_TIME,
          managedRoot: path.join(root, 'managed'),
          migrationDirectory: MIGRATION_DIRECTORY,
          schemaResourceDirectory: SCHEMA_RESOURCE_DIRECTORY,
        }),
      );

      expect(runtime).not.toBeNull();
      expect(runtime?.startupService.getStatus()).toMatchObject({
        state: 'READY',
        writeEnabled: true,
      });
      expect(runtime?.startupService.getStatus().completedPhases).toContain('SCHEMA_REGISTRY');
      expect(runtime?.getSchemaRegistry()?.schemaIds).toHaveLength(4);
      expect(runtime?.getProjectUnitOfWork()).not.toBeNull();
      expect(runtime?.getProjectUnitOfWork()).toBe(runtime?.getProjectUnitOfWork());
      runtime?.close();
      expect(runtime?.getProjectUnitOfWork()).toBeNull();
      expect(runtime?.getSchemaRegistry()).toBeNull();
      const databaseFile = await readFile(path.join(root, 'managed', 'data', 'jingxu.sqlite'));
      expect(databaseFile.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\0');
    } finally {
      runtime?.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('数据库成功但 Schema 资源缺失—启动—保持只读且不发布 Registry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-composition-schema-fault-'));
    let runtime: Awaited<ReturnType<typeof createDesktopPersistenceRuntime>> | null = null;
    try {
      const emptySchemaDirectory = path.join(root, 'empty-schemas');
      await mkdir(emptySchemaDirectory);
      runtime = await createDesktopPersistenceRuntime({
        clock: () => FIXED_TIME,
        managedRoot: path.join(root, 'managed'),
        migrationDirectory: MIGRATION_DIRECTORY,
        schemaResourceDirectory: emptySchemaDirectory,
      });

      expect(runtime.startupService.getStatus()).toMatchObject({
        allowedActions: ['RETRY'],
        currentPhase: 'SCHEMA_REGISTRY',
        errorCode: 'SCHEMA_RESOURCE_MISSING',
        state: 'READ_ONLY_FAULT',
        writeEnabled: false,
      });
      expect(runtime.getSchemaRegistry()).toBeNull();
      runtime.close();
    } finally {
      runtime?.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
