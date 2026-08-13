import type {
  ProviderProfile,
  ProviderProfileRepositoryPort,
  TextModelPort,
} from '@jingxu/application';
import { describe, expect, it, vi } from 'vitest';

import { ProfileTextModelAdapter } from './profile-text-model-adapter';

const profile = (overrides: Partial<ProviderProfile> = {}): ProviderProfile => ({
  baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  config: { dataProcessingHints: [], lastValidatedAt: '2026-08-13T00:00:00.000Z' },
  credentialLast4: '1234',
  credentialRef: 'credential_ref',
  enabled: true,
  id: 'profile_qwen_primary',
  modelId: 'qwen3.7-plus-2026-05-26',
  modelSnapshotDate: '2026-05-26',
  provider: 'QWEN',
  region: 'cn-beijing',
  workspaceId: 'workspace-1',
  ...overrides,
});

const repository = (value: ProviderProfile | null): ProviderProfileRepositoryPort => ({
  delete: vi.fn(() => Promise.resolve()),
  findById: vi.fn(() => Promise.resolve(value)),
  save: vi.fn(() => Promise.resolve()),
});

const model = (): TextModelPort => ({
  generate: vi.fn(() =>
    Promise.resolve({
      finishReason: 'stop',
      modelReported: 'qwen',
      providerRequestId: 'request-1',
      rawText: '{"data":{}}',
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  ),
  normalizeError: vi.fn(
    () =>
      ({
        code: 'MODEL_PROVIDER_ERROR',
        detail: null,
        providerRequestId: null,
        retryable: true,
        userAction: null,
      }) as const,
  ),
  validateCredential: vi.fn(() => Promise.resolve({ ok: true as const })),
});

describe('ProfileTextModelAdapter', () => {
  it('已启用且已验证的配置在每次生成前重新解析，并委托真实 Adapter', async () => {
    const delegated = model();
    const createAdapter = vi.fn(() => delegated);
    const adapter = new ProfileTextModelAdapter({
      createAdapter,
      profileId: 'profile_qwen_primary',
      profiles: repository(profile()),
    });

    const result = await adapter.generate(
      {
        candidateSchemaId: 'candidate',
        finalSchemaId: 'final',
        invocationId: 'invocation-1',
        parameters: {},
        promptTemplateVersion: 'concept/v1',
        stage: 'CONCEPT',
        systemPrompt: 'system',
        userPayload: {},
      },
      new AbortController().signal,
    );

    expect(result.providerRequestId).toBe('request-1');
    expect(createAdapter).toHaveBeenCalledOnce();
  });

  it.each([
    ['缺失配置', null],
    ['禁用配置', profile({ enabled: false })],
    ['未验证配置', profile({ config: { dataProcessingHints: [], lastValidatedAt: null } })],
    ['缺失凭据', profile({ credentialRef: null })],
  ])('%s 在 Provider 调用前稳定拒绝且不泄漏配置', async (_name, value) => {
    const createAdapter = vi.fn(() => model());
    const adapter = new ProfileTextModelAdapter({
      createAdapter,
      profileId: 'profile_qwen_primary',
      profiles: repository(value),
    });

    await expect(adapter.validateCredential()).rejects.toThrow('MODEL_CREDENTIAL_INVALID');
    expect(createAdapter).not.toHaveBeenCalled();
  });
});
