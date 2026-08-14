import { describe, expect, it, vi } from 'vitest';

import type { CredentialPort } from '../ports/credential';
import type { TextModelPort } from '../ports/text-model';
import { ProviderService } from './provider-service';
import type {
  ProviderAuditPort,
  ProviderProfile,
  ProviderProfileDefaults,
  ProviderProfileRepositoryPort,
  ProviderUnitOfWorkPort,
} from './provider-types';

const DEFAULTS: ProviderProfileDefaults = {
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  modelId: 'qwen3.7-plus-2026-05-26',
  modelSnapshotDate: '2026-05-26',
  workspaceId: 'workspace-1',
};

const profile: ProviderProfile = {
  baseUrl: DEFAULTS.baseUrl,
  config: { dataProcessingHints: [], lastValidatedAt: null },
  credentialLast4: null,
  credentialRef: null,
  enabled: true,
  id: 'provider-1',
  modelId: DEFAULTS.modelId,
  modelSnapshotDate: DEFAULTS.modelSnapshotDate,
  provider: 'QWEN',
  region: 'cn-beijing',
  workspaceId: DEFAULTS.workspaceId,
};

const unusedCredentialMethods = (): Pick<
  CredentialPort,
  'deleteCredential' | 'loadCredential'
> => ({
  deleteCredential: vi.fn(() => Promise.resolve()),
  loadCredential: vi.fn(() => Promise.resolve('unused')),
});

describe('ProviderService', () => {
  it('保存凭据—返回视图—只含配置状态与末四位', async () => {
    let stored = profile;
    const credentials: CredentialPort = {
      ...unusedCredentialMethods(),
      isAvailable: () => true,
      saveCredential: vi.fn(() =>
        Promise.resolve({
          createdAt: 'now',
          id: 'opaque-ref',
          kind: 'API_KEY' as const,
          last4: '7890',
        }),
      ),
    };
    const profiles = createProfiles(
      () => stored,
      (next) => {
        stored = next;
      },
    );
    const service = createService(credentials, profiles);

    const view = await service.saveCredential('provider-1', 'fake-value-7890');

    expect(view).toMatchObject({ configured: true, last4: '7890' });
    expect(JSON.stringify(view)).not.toContain('fake-value-7890');
    expect(stored.credentialRef).toBe('opaque-ref');
  });

  it('删除凭据—先事务删行后删密文—避免悬挂已配置态', async () => {
    const stored: ProviderProfile = {
      ...profile,
      credentialLast4: '7890',
      credentialRef: 'opaque-ref',
    };
    const deleteCredential = vi.fn(() => Promise.resolve());
    const credentials: CredentialPort = {
      deleteCredential,
      isAvailable: () => true,
      loadCredential: vi.fn(() => Promise.resolve('unused')),
      saveCredential: vi.fn(() => Promise.reject(new Error('unused'))),
    };
    const deleteRow = vi.fn(() => Promise.resolve());
    const profiles: ProviderProfileRepositoryPort = {
      delete: deleteRow,
      findById: () => Promise.resolve(stored),
      save: vi.fn(() => Promise.resolve()),
    };
    const recordCredentialDeleted = vi.fn(() => Promise.resolve());
    const audit: ProviderAuditPort = { recordCredentialDeleted };
    const unitOfWork: ProviderUnitOfWorkPort = {
      run: (work) => work({ audit, profiles }),
    };
    const service = new ProviderService({
      clock: () => '2026-08-12T00:00:00Z',
      credentials,
      defaults: DEFAULTS,
      profiles,
      textModelFactory: vi.fn(),
      unitOfWork,
    });

    const view = await service.deleteCredential('provider-1');

    expect(deleteCredential).toHaveBeenCalledWith('opaque-ref');
    expect(deleteRow).toHaveBeenCalledWith('provider-1');
    // 顺序是策略：行删除失败回滚时密文文件必须仍在；反序会留下"已配置但密文缺失"。
    expect(deleteRow.mock.invocationCallOrder[0]).toBeLessThan(
      deleteCredential.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(recordCredentialDeleted).toHaveBeenCalledWith('provider-1', '2026-08-12T00:00:00Z');
    expect(view.configured).toBe(false);
  });

  it('连接测试—只调用绑定实例 validateCredential—不执行生成任务', async () => {
    const stored: ProviderProfile = {
      ...profile,
      config: { ...profile.config, lastValidatedAt: '2026-08-11T00:00:00Z' },
      credentialRef: 'opaque-ref',
    };
    const generate = vi.fn<TextModelPort['generate']>();
    const validateCredential = vi.fn(() => Promise.resolve({ ok: true as const }));
    const model: TextModelPort = {
      generate,
      normalizeError: vi.fn(),
      validateCredential,
    };
    const profiles = createProfiles(() => stored);
    const service = createService(
      {
        ...unusedCredentialMethods(),
        isAvailable: () => true,
        saveCredential: vi.fn(() => Promise.reject(new Error('unused'))),
      },
      profiles,
      model,
    );

    await expect(service.testCredential('provider-1')).resolves.toEqual({ ok: true });
    expect(validateCredential).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
  });

  it('saveProfile—更新已存在行的启用状态与工作区', async () => {
    const stored: ProviderProfile = { ...profile, credentialRef: 'opaque-ref' };
    let saved: ProviderProfile | undefined;
    const profiles = createProfiles(
      () => stored,
      (next) => {
        saved = next;
      },
    );
    const service = createService(
      {
        ...unusedCredentialMethods(),
        isAvailable: () => true,
        saveCredential: vi.fn(() => Promise.reject(new Error('unused'))),
      },
      profiles,
    );

    const view = await service.saveProfile('provider-1', 'workspace-2', false);

    expect(saved?.enabled).toBe(false);
    expect(saved?.workspaceId).toBe('workspace-2');
    expect(saved?.config.lastValidatedAt).toBeNull();
    expect(view).toMatchObject({
      enabled: false,
      lastValidatedAt: null,
      versionId: 'provider-1',
    });
  });

  it('saveProfile—行不存在则拒绝（凭据先于配置）', async () => {
    const profiles = createProfiles(() => null);
    const service = createService(
      {
        ...unusedCredentialMethods(),
        isAvailable: () => true,
        saveCredential: vi.fn(() => Promise.reject(new Error('unused'))),
      },
      profiles,
    );

    await expect(service.saveProfile('provider-1', 'workspace-1', true)).rejects.toThrow(
      'PROVIDER_PROFILE_NOT_FOUND',
    );
  });
});

const createProfiles = (
  read: () => ProviderProfile | null,
  write: (profile: ProviderProfile) => void = () => undefined,
): ProviderProfileRepositoryPort => ({
  delete: vi.fn(() => Promise.resolve()),
  findById: () => Promise.resolve(read()),
  save: (next) => {
    write(next);
    return Promise.resolve();
  },
});

const createService = (
  credentials: CredentialPort,
  profiles: ProviderProfileRepositoryPort,
  model?: TextModelPort,
): ProviderService => {
  const audit: ProviderAuditPort = {
    recordCredentialDeleted: vi.fn(() => Promise.resolve()),
  };
  const fallbackModel: TextModelPort = {
    generate: vi.fn(),
    normalizeError: vi.fn(),
    validateCredential: vi.fn(() => Promise.resolve({ ok: true as const })),
  };
  return new ProviderService({
    clock: () => '2026-08-12T00:00:00Z',
    credentials,
    defaults: DEFAULTS,
    profiles,
    textModelFactory: () => model ?? fallbackModel,
    unitOfWork: { run: (work) => work({ audit, profiles }) },
  });
};
