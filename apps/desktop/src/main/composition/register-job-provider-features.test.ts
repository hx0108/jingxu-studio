import type {
  CompiledSchemaRegistry,
  JobRepositoryPort,
  JobUnitOfWorkPort,
  ProviderProfileRepositoryPort,
  ProviderUnitOfWorkPort,
  ScriptUnitOfWorkPort,
} from '@jingxu/application';
import { PROVIDER_IPC_CHANNELS } from '@jingxu/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { SafeStorageFacade } from '../adapters/credential';
import type { JobProviderIpcRegistrar } from '../ipc/job-provider-gate';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';
import { createJobProviderFeatureRegistration } from './register-job-provider-features';

const TRUSTED_URL = 'jingxu://app/index.html';

const trustedEvent = () => {
  const frame = { url: TRUSTED_URL };
  return { sender: { mainFrame: frame }, senderFrame: frame };
};

const safeStorage: SafeStorageFacade = {
  decryptString: () => 'plaintext-key',
  encryptString: () => new Uint8Array([1, 2, 3, 4]),
  isEncryptionAvailable: () => true,
};

interface Harness {
  readonly handlers: Map<
    string,
    (event: ReturnType<typeof trustedEvent>, ...arguments_: readonly unknown[]) => Promise<unknown>
  >;
  readonly setReady: (ready: boolean) => void;
  readonly setUnits: (
    units: {
      providerUnitOfWork: ProviderUnitOfWorkPort | null;
      providerProfileRepository: ProviderProfileRepositoryPort | null;
      jobRepository: JobRepositoryPort | null;
      jobUnitOfWork: JobUnitOfWorkPort | null;
      registry: CompiledSchemaRegistry | null;
      scriptUnitOfWork: ScriptUnitOfWorkPort | null;
    } | null,
  ) => void;
  readonly registration: ReturnType<typeof createJobProviderFeatureRegistration>;
}

const createHarness = (): Harness => {
  const handlers = new Map<
    string,
    (event: ReturnType<typeof trustedEvent>, ...arguments_: readonly unknown[]) => Promise<unknown>
  >();
  const registrar: JobProviderIpcRegistrar = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
  };

  let ready = false;
  let units: {
    providerUnitOfWork: ProviderUnitOfWorkPort | null;
    providerProfileRepository: ProviderProfileRepositoryPort | null;
    jobRepository: JobRepositoryPort | null;
    jobUnitOfWork: JobUnitOfWorkPort | null;
    registry: CompiledSchemaRegistry | null;
    scriptUnitOfWork: ScriptUnitOfWorkPort | null;
  } | null = null;

  // 恢复扫描通过 jobUnitOfWork.run 读取待恢复证据；#5 表为空 → 两个 finder 返回空数组。
  const emptyRecoveryRepositories = {
    invocations: { listRecoveryEvidence: vi.fn(() => Promise.resolve([])) },
    jobs: { listByStatuses: vi.fn(() => Promise.resolve([])) },
  } as never;
  const emptyJobUnitOfWork: JobUnitOfWorkPort = {
    run: (work) => work(emptyRecoveryRepositories),
  };

  const persistenceRuntime = {
    getJobRepository: () => units?.jobRepository ?? null,
    getJobUnitOfWork: () => units?.jobUnitOfWork ?? null,
    getProviderProfileRepository: () => units?.providerProfileRepository ?? null,
    getProviderUnitOfWork: () => units?.providerUnitOfWork ?? null,
    getSchemaRegistry: () => units?.registry ?? null,
    getScriptUnitOfWork: () => units?.scriptUnitOfWork ?? null,
    startupService: { getStatus: () => ({ writeEnabled: ready }) },
  } as unknown as DesktopPersistenceRuntime;

  const registration = createJobProviderFeatureRegistration({
    clock: () => '2026-08-12T00:00:00.000Z',
    ipcRegistrar: registrar,
    managedRoot: '/tmp/jingxu-managed',
    persistenceRuntime,
    safeStorage,
    trustedUrl: TRUSTED_URL,
  });

  return {
    handlers,
    registration,
    setReady: (value: boolean) => {
      ready = value;
    },
    setUnits: (value) => {
      units =
        value === null
          ? null
          : { ...value, jobUnitOfWork: value.jobUnitOfWork ?? emptyJobUnitOfWork };
    },
  };
};

const configuredUnits = () => ({
  jobRepository: {
    findById: vi.fn(),
    findByIdempotencyKey: vi.fn(),
    listByStatuses: vi.fn(),
  } as unknown as JobRepositoryPort,
  jobUnitOfWork: null,
  registry: {
    schemaIds: [],
    validate: () => ({ issues: [], schemaId: 'script', valid: true }),
  } as CompiledSchemaRegistry,
  scriptUnitOfWork: {
    run: (work: (repositories: never) => Promise<unknown>) =>
      work({
        invocations: { listRecoveryEvidence: vi.fn(() => Promise.resolve([])) },
        jobs: { listByStatuses: vi.fn(() => Promise.resolve([])) },
      } as never),
  } as unknown as ScriptUnitOfWorkPort,
  providerProfileRepository: {
    delete: vi.fn(),
    findById: vi.fn(() => Promise.resolve(null)),
    save: vi.fn(),
  } as unknown as ProviderProfileRepositoryPort,
  // getProfile 只走 profiles.findById（独立读路径），不触碰 unitOfWork；该 run 体为死代码。
  providerUnitOfWork: {
    run: (work: (repositories: never) => Promise<unknown>) => work({} as never),
  } as unknown as ProviderUnitOfWorkPort,
});

describe('createJobProviderFeatureRegistration — Composition Root', () => {
  it('非 READY—读命令经 facade 归一化为 STARTUP_WRITE_BLOCKED 且不构造服务', async () => {
    const h = createHarness();
    h.setReady(false);

    const result = (await h.handlers.get(PROVIDER_IPC_CHANNELS.getProfile)?.(trustedEvent(), {
      profileId: 'profile_12345678',
    })) as { ok: false; error: { code: string } };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('STARTUP_WRITE_BLOCKED');
    expect(h.registration.ensureRegistered()).toBe(false);
  });

  it('READY 但持久化 UoW 尚未就绪—ensureRegistered 返回 false 且不构造服务', () => {
    const h = createHarness();
    h.setReady(true);
    h.setUnits({
      jobRepository: null,
      jobUnitOfWork: null,
      providerProfileRepository: null,
      providerUnitOfWork: null,
      registry: null,
      scriptUnitOfWork: null,
    });

    expect(h.registration.ensureRegistered()).toBe(false);
  });

  it('READY 且 UoW 就绪—ensureRegistered 构造服务、返回 true，且只激活一次', () => {
    const h = createHarness();
    h.setReady(true);
    h.setUnits(configuredUnits());

    expect(h.registration.ensureRegistered()).toBe(true);
    expect(h.registration.ensureRegistered()).toBe(false);
  });

  it('ensureRegistered 后—读命令经 gate→facade→真实 ProviderService—返回虚拟默认 DTO', async () => {
    const h = createHarness();
    h.setReady(true);
    h.setUnits(configuredUnits());
    h.registration.ensureRegistered();

    const result = (await h.handlers.get(PROVIDER_IPC_CHANNELS.getProfile)?.(trustedEvent(), {
      profileId: 'profile_12345678',
    })) as { ok: true; data: { configured: boolean; last4: string | null; provider: string } };

    expect(result.ok).toBe(true);
    expect(result.data.provider).toBe('QWEN');
    expect(result.data.configured).toBe(false);
    expect(result.data.last4).toBeNull();
  });
});
