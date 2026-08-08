import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    try {
      const runtime = await initializePersistenceAfterSingleInstanceLock(true, () =>
        createDesktopPersistenceRuntime({
          clock: () => FIXED_TIME,
          managedRoot: path.join(root, 'managed'),
          migrationDirectory: MIGRATION_DIRECTORY,
        }),
      );

      expect(runtime).not.toBeNull();
      expect(runtime?.startupService.getStatus()).toMatchObject({
        state: 'READY',
        writeEnabled: true,
      });
      runtime?.close();
      const databaseFile = await readFile(path.join(root, 'managed', 'data', 'jingxu.sqlite'));
      expect(databaseFile.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\0');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
