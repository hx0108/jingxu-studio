import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  CompiledSchemaRegistry,
  JobRepositoryPort,
  JobUnitOfWorkPort,
  ProviderProfile,
  ProviderProfileRepositoryPort,
  ProviderUnitOfWorkPort,
  ScriptUnitOfWorkPort,
} from '@jingxu/application';
import { PROVIDER_IPC_CHANNELS } from '@jingxu/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SafeStorageFacade } from '../adapters/credential';
import type { JobProviderIpcRegistrar } from '../ipc/job-provider-gate';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';
import { createJobProviderFeatureRegistration } from './register-job-provider-features';

const TRUSTED_URL = 'jingxu://app/index.html';

const roots: string[] = [];
const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-jp-features-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))),
);

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
  readonly root: string;
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

const createHarness = (
  overrides: { managedRoot?: string; safeStorage?: SafeStorageFacade } = {},
): Harness => {
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
    managedRoot: overrides.managedRoot ?? '/tmp/jingxu-managed',
    persistenceRuntime,
    safeStorage: overrides.safeStorage ?? safeStorage,
    trustedUrl: TRUSTED_URL,
  });

  return {
    handlers,
    registration,
    root: overrides.managedRoot ?? '/tmp/jingxu-managed',
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

  it('图片档凭据闭环—保存→解密测试→删除—密文清理、审计事件、两档互不干扰', async () => {
    // 可逆 safeStorage 替身（密文=enc:+明文）：只为让解密测试可判真伪；
    // 落盘仅密文由 credential-adapter 测试另行钉死。
    const reversibleStorage: SafeStorageFacade = {
      decryptString: (encrypted) => new TextDecoder().decode(encrypted).replace(/^enc:/u, ''),
      encryptString: (plaintext) => new TextEncoder().encode(`enc:${plaintext}`),
      isEncryptionAvailable: () => true,
    };
    const profiles = new Map<string, ProviderProfile>();
    const auditEvents: string[] = [];
    const units = configuredUnits();
    units.providerProfileRepository = {
      delete: (id: string) => {
        profiles.delete(id);
        return Promise.resolve();
      },
      findById: (id: string) => Promise.resolve(profiles.get(id) ?? null),
      save: (profile: ProviderProfile) => {
        profiles.set(profile.id, profile);
        return Promise.resolve();
      },
    };
    units.providerUnitOfWork = {
      run: (work: (repositories: never) => Promise<unknown>) =>
        work({
          audit: {
            recordCredentialDeleted: (id: string) => {
              auditEvents.push(id);
              return Promise.resolve();
            },
          },
          profiles: units.providerProfileRepository,
        } as never),
    } as unknown as ProviderUnitOfWorkPort;

    const h = createHarness({ managedRoot: await createRoot(), safeStorage: reversibleStorage });
    h.setReady(true);
    h.setUnits(units);
    h.registration.ensureRegistered();
    const invoke = (channel: string, input: unknown) =>
      h.handlers.get(channel)?.(trustedEvent(), input) as Promise<{
        ok: boolean;
        data?: { configured: boolean; last4: string | null; provider: string; validated: boolean };
      }>;
    const IMAGE_INPUT = { profileId: 'profile-image-primary' };

    // 保存：图片档行惰性建档，末 4 位回读，provider=VOLCARK_SEEDREAM。
    const saved = await invoke(PROVIDER_IPC_CHANNELS.saveCredential, {
      apiKey: 'ark-key-abcd9999',
      expectedVersionId: 'profile-image-primary',
      profileId: 'profile-image-primary',
      requestId: 'request-image-save-0001',
    });
    expect(saved.ok).toBe(true);
    expect(saved.data).toMatchObject({
      configured: true,
      last4: '9999',
      provider: 'VOLCARK_SEEDREAM',
    });

    // 测试：解密校验成功并落 lastValidatedAt（零网络）。
    const tested = await invoke(PROVIDER_IPC_CHANNELS.testCredential, {
      ...IMAGE_INPUT,
      expectedVersionId: 'profile-image-primary',
      requestId: 'request-image-test-0001',
    });
    expect(tested.ok).toBe(true);
    expect(tested.data?.validated).toBe(true);

    // 删除：行清理 + 审计事件 + 密文文件清理。
    const deleted = await invoke(PROVIDER_IPC_CHANNELS.deleteCredential, {
      ...IMAGE_INPUT,
      expectedVersionId: 'profile-image-primary',
      requestId: 'request-image-delete-0001',
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.data?.configured).toBe(false);
    expect(auditEvents).toEqual(['profile-image-primary']);
    expect(await readdir(path.join(h.root, 'secrets'))).toEqual([]);

    // 两档互不干扰：文本档保存产生独立 UUID 密文，图片档保持未配置。
    const textSaved = await invoke(PROVIDER_IPC_CHANNELS.saveCredential, {
      apiKey: 'qwen-key-abcd4321',
      expectedVersionId: 'profile_qwen_primary',
      profileId: 'profile_qwen_primary',
      requestId: 'request-text-save-0001',
    });
    expect(textSaved.data).toMatchObject({ configured: true, last4: '4321', provider: 'QWEN' });
    const imageView = await invoke(PROVIDER_IPC_CHANNELS.getProfile, IMAGE_INPUT);
    expect(imageView.data?.configured).toBe(false);
    const secretFiles = await readdir(path.join(h.root, 'secrets'));
    expect(secretFiles).toHaveLength(1);
    expect(secretFiles[0]).not.toBe('profile-image-primary.bin');
  });

  it('视频档凭据闭环—保存→解密测试→删除—密文按视频固定 id 落盘、审计事件、图片档不受干扰', async () => {
    const reversibleStorage: SafeStorageFacade = {
      decryptString: (encrypted) => new TextDecoder().decode(encrypted).replace(/^enc:/u, ''),
      encryptString: (plaintext) => new TextEncoder().encode(`enc:${plaintext}`),
      isEncryptionAvailable: () => true,
    };
    const profiles = new Map<string, ProviderProfile>();
    const auditEvents: string[] = [];
    const units = configuredUnits();
    units.providerProfileRepository = {
      delete: (id: string) => {
        profiles.delete(id);
        return Promise.resolve();
      },
      findById: (id: string) => Promise.resolve(profiles.get(id) ?? null),
      save: (profile: ProviderProfile) => {
        profiles.set(profile.id, profile);
        return Promise.resolve();
      },
    };
    units.providerUnitOfWork = {
      run: (work: (repositories: never) => Promise<unknown>) =>
        work({
          audit: {
            recordCredentialDeleted: (id: string) => {
              auditEvents.push(id);
              return Promise.resolve();
            },
          },
          profiles: units.providerProfileRepository,
        } as never),
    } as unknown as ProviderUnitOfWorkPort;

    const h = createHarness({ managedRoot: await createRoot(), safeStorage: reversibleStorage });
    h.setReady(true);
    h.setUnits(units);
    h.registration.ensureRegistered();
    const invoke = (channel: string, input: unknown) =>
      h.handlers.get(channel)?.(trustedEvent(), input) as Promise<{
        ok: boolean;
        data?: {
          configured: boolean;
          last4: string | null;
          modelId: string;
          provider: string;
          validated: boolean;
        };
      }>;
    const VIDEO_INPUT = { profileId: 'profile-video-primary' };

    // 首次配置可先保存模型，不必先输入密钥；随后保存 Key 必须保留选定模型。
    const selected = await invoke(PROVIDER_IPC_CHANNELS.saveProfile, {
      enabled: true,
      expectedVersionId: 'profile-video-primary',
      modelId: 'doubao-seedance-2-5-260628',
      profileId: 'profile-video-primary',
      requestId: 'request-video-model-0001',
      workspaceId: 'ark',
    });
    expect(selected.ok).toBe(true);
    expect(selected.data).toMatchObject({ modelId: 'doubao-seedance-2-5-260628' });

    // 保存：视频档行惰性建档，末 4 位回读，provider=VOLCARK_SEEDANCE、Seedance model id。
    const saved = await invoke(PROVIDER_IPC_CHANNELS.saveCredential, {
      apiKey: 'ark-key-video7777',
      expectedVersionId: 'profile-video-primary',
      profileId: 'profile-video-primary',
      requestId: 'request-video-save-0001',
    });
    expect(saved.ok).toBe(true);
    expect(saved.data).toMatchObject({
      configured: true,
      last4: '7777',
      modelId: 'doubao-seedance-2-5-260628',
      provider: 'VOLCARK_SEEDANCE',
    });
    // 密文按视频固定 id 独立落盘（与图片档分存）。
    expect(await readdir(path.join(h.root, 'secrets'))).toEqual(['profile-video-primary.bin']);

    // 测试：解密校验成功并落 lastValidatedAt（零网络）。
    const tested = await invoke(PROVIDER_IPC_CHANNELS.testCredential, {
      ...VIDEO_INPUT,
      expectedVersionId: 'profile-video-primary',
      requestId: 'request-video-test-0001',
    });
    expect(tested.ok).toBe(true);
    expect(tested.data?.validated).toBe(true);

    // 删除：行清理 + 审计事件 + 密文文件清理。
    const deleted = await invoke(PROVIDER_IPC_CHANNELS.deleteCredential, {
      ...VIDEO_INPUT,
      expectedVersionId: 'profile-video-primary',
      requestId: 'request-video-delete-0001',
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.data?.configured).toBe(false);
    expect(auditEvents).toEqual(['profile-video-primary']);
    expect(await readdir(path.join(h.root, 'secrets'))).toEqual([]);

    // 图片档与文本档保持未配置（三档互不干扰）。
    const imageView = await invoke(PROVIDER_IPC_CHANNELS.getProfile, {
      profileId: 'profile-image-primary',
    });
    expect(imageView.data?.configured).toBe(false);
  });
});
