import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PROJECT_IPC_CHANNELS } from '@jingxu/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { ProjectIpcEvent } from '../ipc/project-ipc';
import { createDesktopPersistenceRuntime } from './create-persistence-runtime';
import { createProjectFeatureRegistration } from './register-project-features';

const MIGRATION_DIRECTORY = path.resolve(
  import.meta.dirname,
  '../../../../../packages/persistence/resources/migrations',
);
const SCHEMA_RESOURCE_DIRECTORY = path.resolve(
  import.meta.dirname,
  '../../../../../packages/validation/resources/schemas/v1',
);
const TRUSTED_URL = 'jingxu://app/index.html';
const FIXED_TIME = '2026-08-10T00:00:00.000Z';

const trustedEvent = (): ProjectIpcEvent => {
  const frame = { url: TRUSTED_URL };
  return { sender: { mainFrame: frame }, senderFrame: frame };
};

type ProjectHandler = (
  event: ProjectIpcEvent,
  ...arguments_: readonly unknown[]
) => Promise<unknown>;

describe('Project Composition Root', () => {
  it('READY 运行时—重复确保注册—复用单一连接且六个 Project handler 只注册一次', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-project-composition-'));
    const managedRoot = path.join(root, 'managed');
    const beforePragma = vi.fn();
    const handlers = new Map<string, ProjectHandler>();
    const handle = vi.fn((channel: string, listener: ProjectHandler) => {
      handlers.set(channel, listener);
    });

    try {
      const runtime = await createDesktopPersistenceRuntime({
        clock: () => FIXED_TIME,
        managedRoot,
        migrationDirectory: MIGRATION_DIRECTORY,
        schemaResourceDirectory: SCHEMA_RESOURCE_DIRECTORY,
        sqliteConnectionOptions: { beforePragma },
      });
      const registration = createProjectFeatureRegistration({
        ipcRegistrar: { handle },
        managedRoot,
        persistenceRuntime: runtime,
        trustedUrl: TRUSTED_URL,
      });

      expect(registration.ensureRegistered()).toBe(true);
      expect(registration.ensureRegistered()).toBe(false);
      expect(handle).toHaveBeenCalledTimes(6);
      expect([...handlers.keys()].sort()).toEqual(Object.values(PROJECT_IPC_CHANNELS).sort());
      expect(beforePragma).toHaveBeenCalledTimes(4);

      const create = handlers.get(PROJECT_IPC_CHANNELS.create);
      if (create === undefined) throw new Error('project.create handler missing');
      await expect(
        create(trustedEvent(), {
          requestId: 'request-create-composition-0001',
          name: '组合根项目',
          genre: null,
          style: null,
          creationMode: 'AI_ORIGINAL',
          dialogueRenderMode: 'NARRATION_FIRST',
          aspectRatio: '9:16',
          subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(beforePragma).toHaveBeenCalledTimes(4);
      runtime.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('Schema 启动故障—注册安全边界但不构造可写能力—四个 Command 返回稳定写门错误', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-project-fault-composition-'));
    const managedRoot = path.join(root, 'managed');
    const emptySchemaDirectory = path.join(root, 'empty-schemas');
    await mkdir(emptySchemaDirectory);
    const handlers = new Map<string, ProjectHandler>();
    const handle = vi.fn((channel: string, listener: ProjectHandler) => {
      handlers.set(channel, listener);
    });

    try {
      const runtime = await createDesktopPersistenceRuntime({
        clock: () => FIXED_TIME,
        managedRoot,
        migrationDirectory: MIGRATION_DIRECTORY,
        schemaResourceDirectory: emptySchemaDirectory,
      });
      const registration = createProjectFeatureRegistration({
        ipcRegistrar: { handle },
        managedRoot,
        persistenceRuntime: runtime,
        trustedUrl: TRUSTED_URL,
      });

      expect(runtime.startupService.getStatus()).toMatchObject({
        currentPhase: 'SCHEMA_REGISTRY',
        errorCode: 'SCHEMA_RESOURCE_MISSING',
        state: 'READ_ONLY_FAULT',
        writeEnabled: false,
      });
      expect(runtime.getProjectUnitOfWork()).not.toBeNull();
      expect(registration.ensureRegistered()).toBe(false);
      expect(handle).toHaveBeenCalledTimes(6);

      const inputs = new Map<string, unknown>([
        [
          PROJECT_IPC_CHANNELS.create,
          {
            requestId: 'request-create-fault-0001',
            name: '故障态项目',
            genre: null,
            style: null,
            creationMode: 'AI_ORIGINAL',
            dialogueRenderMode: 'NARRATION_FIRST',
            aspectRatio: '9:16',
            subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
          },
        ],
        [
          PROJECT_IPC_CHANNELS.update,
          {
            requestId: 'request-update-fault-0001',
            projectId: 'project-fault-0001',
            expectedUpdatedAt: FIXED_TIME,
            name: '故障态项目',
            genre: null,
            style: null,
            dialogueRenderMode: 'NARRATION_FIRST',
            aspectRatio: '9:16',
            subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
          },
        ],
        [
          PROJECT_IPC_CHANNELS.delete,
          {
            requestId: 'request-delete-fault-0001',
            projectId: 'project-fault-0001',
            expectedUpdatedAt: FIXED_TIME,
          },
        ],
        [
          PROJECT_IPC_CHANNELS.restore,
          {
            requestId: 'request-restore-fault-0001',
            projectId: 'project-fault-0001',
            expectedUpdatedAt: FIXED_TIME,
          },
        ],
      ]);

      for (const [channel, input] of inputs) {
        const handler = handlers.get(channel);
        if (handler === undefined) throw new Error(`${channel} handler missing`);
        await expect(handler(trustedEvent(), input)).resolves.toMatchObject({
          ok: false,
          error: { code: 'STARTUP_WRITE_BLOCKED' },
        });
      }
      runtime.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
