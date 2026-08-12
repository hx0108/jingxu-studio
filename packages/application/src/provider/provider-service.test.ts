import { describe, expect, it, vi } from 'vitest';

import type { CredentialPort } from '../ports/credential';
import type { TextModelPort } from '../ports/text-model';
import { ProviderService } from './provider-service';
import type {
  ProviderAuditPort,
  ProviderProfile,
  ProviderProfileRepositoryPort,
  ProviderUnitOfWorkPort,
} from './provider-types';

const profile: ProviderProfile = {
  credentialLast4: null,
  credentialRef: null,
  enabled: true,
  id: 'provider-1',
  lastValidatedAt: null,
  modelId: 'qwen3.7-plus-2026-05-26',
  modelSnapshotDate: '2026-05-26',
  provider: 'QWEN',
  region: 'cn-beijing',
  workspaceId: 'workspace-1',
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

  it('删除凭据—同步删密文与引用—同一 UnitOfWork 写审计', async () => {
    let stored: ProviderProfile = { ...profile, credentialRef: 'opaque-ref' };
    const deleteCredential = vi.fn(() => Promise.resolve());
    const credentials: CredentialPort = {
      deleteCredential,
      isAvailable: () => true,
      loadCredential: vi.fn(() => Promise.resolve('unused')),
      saveCredential: vi.fn(() => Promise.reject(new Error('unused'))),
    };
    const profiles = createProfiles(
      () => stored,
      (next) => {
        stored = next;
      },
    );
    const recordCredentialDeleted = vi.fn(() => Promise.resolve());
    const audit: ProviderAuditPort = { recordCredentialDeleted };
    const unitOfWork: ProviderUnitOfWorkPort = {
      run: (work) => work({ audit, profiles }),
    };
    const service = new ProviderService({
      clock: () => '2026-08-12T00:00:00Z',
      credentials,
      profiles,
      textModelFactory: vi.fn(),
      unitOfWork,
    });

    await service.deleteCredential('provider-1');

    expect(deleteCredential).toHaveBeenCalledWith('opaque-ref');
    expect(stored.credentialRef).toBeNull();
    expect(recordCredentialDeleted).toHaveBeenCalledWith('provider-1', '2026-08-12T00:00:00Z');
  });

  it('连接测试—只调用绑定实例 validateCredential—不执行生成任务', async () => {
    const stored: ProviderProfile = { ...profile, credentialRef: 'opaque-ref' };
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
});

const createProfiles = (
  read: () => ProviderProfile,
  write: (profile: ProviderProfile) => void = () => undefined,
): ProviderProfileRepositoryPort => ({
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
    profiles,
    textModelFactory: () => model ?? fallbackModel,
    unitOfWork: { run: (work) => work({ audit, profiles }) },
  });
};
