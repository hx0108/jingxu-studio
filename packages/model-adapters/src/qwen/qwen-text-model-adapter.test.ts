import { describe, expect, it, vi } from 'vitest';

import type { CredentialPort, TextGenerationRequest } from '@jingxu/application';

import { QWEN_MODEL_ID, QwenTextModelAdapter, deriveQwenBaseUrl } from './qwen-text-model-adapter';

const credentialPort: CredentialPort = {
  deleteCredential: vi.fn(),
  isAvailable: () => true,
  loadCredential: vi.fn(() => Promise.resolve('fake-credential-value')),
  saveCredential: vi.fn(),
};
const request: TextGenerationRequest = {
  candidateSchemaId: 'candidate/v1',
  finalSchemaId: 'final/v1',
  invocationId: 'invocation-1',
  parameters: { temperature: 0 },
  promptTemplateVersion: 'concept/v1',
  stage: 'CONCEPT',
  systemPrompt: 'Return JSON only.',
  userPayload: { text: 'hello' },
};
const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

describe('QwenTextModelAdapter', () => {
  it('固定配置—生成—使用日期模型、非思考 JSON Mode 与公共端点 Host', async () => {
    const calls: { init: RequestInit | undefined; url: string }[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      calls.push({ init, url: input instanceof Request ? input.url : input.toString() });
      return Promise.resolve(
        response(200, {
          choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
          id: 'provider-request-1',
          model: QWEN_MODEL_ID,
          usage: { completion_tokens: 3, prompt_tokens: 8 },
        }),
      );
    };
    const adapter = new QwenTextModelAdapter({
      credentialId: 'credential-1',
      credentialPort,
      fetch,
      workspaceId: 'workspace-123',
    });
    const result = await adapter.generate(request, new AbortController().signal);
    expect(result).toMatchObject({
      providerRequestId: 'provider-request-1',
      rawText: '{"ok":true}',
    });
    const { init, url } = calls[0] ?? { init: undefined, url: '' };
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      enable_thinking: false,
      model: QWEN_MODEL_ID,
      response_format: { type: 'json_object' },
    });
    expect(body).not.toHaveProperty('max_tokens');
  });

  it.each(['qwen-plus', 'workspace_unsafe', 'workspace.example.com', ''])(
    '漂移模型或非法 workspace %j—配置—拒绝且不调用网络',
    (value) => {
      expect(() =>
        value === 'qwen-plus'
          ? new QwenTextModelAdapter({
              credentialId: 'credential-1',
              credentialPort,
              fetch: vi.fn(),
              modelId: value,
              workspaceId: 'workspace-123',
            })
          : deriveQwenBaseUrl(value),
      ).toThrow('MODEL_CONFIGURATION_INVALID');
    },
  );

  it('组装输入超过 64K Token—生成—阻断且不裁剪或调用网络', async () => {
    const fetch = vi.fn();
    const adapter = new QwenTextModelAdapter({
      countInputTokens: () => 65_537,
      credentialId: 'credential-1',
      credentialPort,
      fetch,
      workspaceId: 'workspace-123',
    });
    await expect(adapter.generate(request, new AbortController().signal)).rejects.toMatchObject({
      normalized: { code: 'MODEL_INPUT_TOO_LARGE' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'MODEL_CREDENTIAL_INVALID', false],
    [429, 'MODEL_RATE_LIMITED', true],
    [503, 'MODEL_PROVIDER_ERROR', true],
  ] as const)('HTTP %i—归一化—稳定脱敏错误', async (status, code, retryable) => {
    const secretBody = 'Authorization: Bearer fake-credential-value';
    const adapter = new QwenTextModelAdapter({
      credentialId: 'credential-1',
      credentialPort,
      fetch: vi.fn(() => Promise.resolve(new Response(secretBody, { status }))),
      workspaceId: 'workspace-123',
    });
    try {
      await adapter.generate(request, new AbortController().signal);
      throw new Error('EXPECTED_FAILURE');
    } catch (error) {
      const failure = adapter.normalizeError(error);
      expect(failure).toMatchObject({ code, retryable });
      expect(JSON.stringify(failure)).not.toContain('fake-credential-value');
      expect(JSON.stringify(failure)).not.toContain(secretBody);
    }
  });

  it('成功响应结构非法—生成—归一化为 MODEL_INVALID_RESPONSE', async () => {
    const adapter = new QwenTextModelAdapter({
      credentialId: 'credential-1',
      credentialPort,
      fetch: vi.fn(() => Promise.resolve(response(200, { choices: [] }))),
      workspaceId: 'workspace-123',
    });
    await expect(adapter.generate(request, new AbortController().signal)).rejects.toMatchObject({
      normalized: { code: 'MODEL_INVALID_RESPONSE' },
    });
  });

  it('120 秒超时信号触发—生成—归一化为 MODEL_TIMEOUT', async () => {
    const adapter = new QwenTextModelAdapter({
      credentialId: 'credential-1',
      credentialPort,
      fetch: vi.fn(() => Promise.reject(new DOMException('timeout', 'TimeoutError'))),
      timeoutSignal: () => AbortSignal.abort(new DOMException('timeout', 'TimeoutError')),
      workspaceId: 'workspace-123',
    });
    try {
      await adapter.generate(request, new AbortController().signal);
      throw new Error('EXPECTED_FAILURE');
    } catch (error) {
      expect(adapter.normalizeError(error).code).toBe('MODEL_TIMEOUT');
    }
  });

  it('message.content 为字符串但 JSON 非法—原样返回—交给 Candidate Pipeline 修复', async () => {
    const adapter = new QwenTextModelAdapter({
      credentialId: 'credential-1',
      credentialPort,
      fetch: vi.fn(() =>
        Promise.resolve(
          response(200, { choices: [{ finish_reason: 'stop', message: { content: '{' } }] }),
        ),
      ),
      workspaceId: 'workspace-123',
    });
    await expect(adapter.generate(request, new AbortController().signal)).resolves.toMatchObject({
      rawText: '{',
    });
  });
});
