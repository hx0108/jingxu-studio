import { describe, expect, it, vi } from 'vitest';

import { MockTextModelAdapter, createMockModelError } from './mock-text-model-adapter';

import type { TextGenerationRequest } from '@jingxu/application';

const request: TextGenerationRequest = {
  candidateSchemaId: 'candidate-script-stage/1',
  finalSchemaId: 'https://jingxu.studio/schemas/script-stage-output/1.0.0',
  invocationId: 'invocation_1',
  parameters: {},
  promptTemplateVersion: 'script-stage/v1',
  stage: 'CONCEPT',
  systemPrompt: 'Return JSON.',
  userPayload: { idea: 'test' },
};

describe('MockTextModelAdapter', () => {
  it('按声明顺序返回确定性成功与错误，且不访问网络', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const adapter = new MockTextModelAdapter({
      now: () => 1_000,
      steps: [
        { kind: 'success', rawText: '{"data":{"title":"A"}}' },
        { kind: 'error', error: createMockModelError('MODEL_CREDENTIAL_INVALID') },
        { kind: 'error', error: createMockModelError('MODEL_RATE_LIMITED') },
        { kind: 'error', error: createMockModelError('MODEL_PROVIDER_ERROR') },
        { kind: 'invalid-json', rawText: '{' },
      ],
    });

    await expect(adapter.generate(request, new AbortController().signal)).resolves.toMatchObject({
      providerRequestId: 'mock-request-1000-1',
      rawText: '{"data":{"title":"A"}}',
    });
    for (const code of [
      'MODEL_CREDENTIAL_INVALID',
      'MODEL_RATE_LIMITED',
      'MODEL_PROVIDER_ERROR',
    ] as const) {
      await expect(adapter.generate(request, new AbortController().signal)).rejects.toMatchObject({
        normalized: { code },
      });
    }
    await expect(adapter.generate(request, new AbortController().signal)).resolves.toMatchObject({
      rawText: '{',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('以可注入等待器模拟 120 秒超时而不进行真实等待', async () => {
    const wait = vi.fn(() => Promise.resolve());
    const adapter = new MockTextModelAdapter({
      now: () => 2_000,
      wait,
      steps: [{ kind: 'timeout', afterMs: 120_000 }],
    });

    await expect(adapter.generate(request, new AbortController().signal)).rejects.toMatchObject({
      normalized: { code: 'MODEL_TIMEOUT' },
    });
    expect(wait).toHaveBeenCalledWith(120_000, expect.any(AbortSignal));
  });

  it('取消可中断普通响应，并允许显式模拟取消后的迟到响应', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const adapter = new MockTextModelAdapter({
      steps: [{ kind: 'success', rawText: '{}', afterMs: 10 }],
      wait: () => Promise.resolve(),
    });

    await expect(adapter.generate(request, cancelled.signal)).rejects.toMatchObject({
      normalized: { code: 'MODEL_CANCELLED' },
    });
    const lateAdapter = new MockTextModelAdapter({
      steps: [{ kind: 'late-response', rawText: '{"late":true}', afterMs: 10 }],
      wait: () => Promise.resolve(),
    });
    await expect(lateAdapter.generate(request, cancelled.signal)).resolves.toMatchObject({
      rawText: '{"late":true}',
    });
  });

  it('序列耗尽时稳定失败，normalizeError 不泄露原始对象', () => {
    const adapter = new MockTextModelAdapter({ steps: [] });
    const normalized = adapter.normalizeError({ authorization: 'secret' });

    expect(normalized).toEqual({
      code: 'MODEL_UNKNOWN',
      detail: 'Mock model call failed.',
      providerRequestId: null,
      retryable: false,
      userAction: null,
    });
    expect(JSON.stringify(normalized)).not.toContain('secret');
  });
});
