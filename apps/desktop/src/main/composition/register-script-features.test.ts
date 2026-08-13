import { describe, expect, it, vi } from 'vitest';

import { SCRIPT_IPC_CHANNELS } from '@jingxu/contracts';
import type { ScriptIpcService } from '../ipc/script-ipc';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';
import { createScriptFeatureRegistration } from './register-script-features';

const createHarness = (writeEnabled: boolean, scriptAvailable = true) => {
  const channels: string[] = [];
  const service = {} as ScriptIpcService;
  const createService = vi.fn(() => service);
  const unitOfWork = { run: vi.fn() };
  const workspaceQuery = { getVersionDocument: vi.fn(), getWorkspace: vi.fn() };
  const jobs = { listByStatuses: vi.fn() };
  const projects = { run: vi.fn() };
  const registry = { schemaIds: [], validate: vi.fn() };
  const runtime = {
    getJobRepository: () => (scriptAvailable ? jobs : null),
    getProjectUnitOfWork: () => (scriptAvailable ? projects : null),
    getSchemaRegistry: () => (scriptAvailable ? registry : null),
    getScriptUnitOfWork: () => (scriptAvailable ? unitOfWork : null),
    getScriptWorkspaceQuery: () => (scriptAvailable ? workspaceQuery : null),
    startupService: { getStatus: () => ({ writeEnabled }) },
  } as unknown as DesktopPersistenceRuntime;
  const registration = createScriptFeatureRegistration({
    createService,
    ipcRegistrar: {
      handle: (channel) => {
        channels.push(channel);
      },
    },
    newTraceId: () => 'trace-00000001',
    persistenceRuntime: runtime,
    trustedUrl: 'file://jingxu/index.html',
  });
  return {
    channels,
    createService,
    jobs,
    projects,
    registration,
    registry,
    unitOfWork,
    workspaceQuery,
  };
};

describe('createScriptFeatureRegistration', () => {
  it('条件—READY 且 Script Runtime 可用—只注册五个 Script 频道且只激活一次', () => {
    const harness = createHarness(true);
    expect(harness.registration.ensureRegistered()).toBe(true);
    expect(harness.registration.ensureRegistered()).toBe(false);
    expect(harness.channels.sort()).toEqual(Object.values(SCRIPT_IPC_CHANNELS).sort());
    expect(harness.channels.every((channel) => channel.startsWith('script.'))).toBe(true);
    expect(harness.createService).toHaveBeenCalledWith({
      jobs: harness.jobs,
      projects: harness.projects,
      registry: harness.registry,
      unitOfWork: harness.unitOfWork,
      workspaceQuery: harness.workspaceQuery,
    });
  });

  it.each([
    ['启动未 READY', false, true],
    ['Script Runtime 不可用', true, false],
  ])('条件—%s—不构造 Service且不注册任何频道', (_label, ready, available) => {
    const harness = createHarness(ready, available);
    expect(harness.registration.ensureRegistered()).toBe(false);
    expect(harness.createService).not.toHaveBeenCalled();
    expect(harness.channels.sort()).toEqual(Object.values(SCRIPT_IPC_CHANNELS).sort());
  });
});
