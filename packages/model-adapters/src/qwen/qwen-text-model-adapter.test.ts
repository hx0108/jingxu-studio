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

  it.each([
    ['DataInspectionFailed', 'MODEL_CONTENT_REJECTED', '调整输入内容后重试'] as const,
    [
      'Model.AccessDenied',
      'MODEL_MODEL_UNAVAILABLE',
      '确认百炼账号已开通该模型且未欠费，或在设置中更换服务密钥',
    ] as const,
    [
      'Arrearage',
      'MODEL_MODEL_UNAVAILABLE',
      '确认百炼账号已开通该模型且未欠费，或在设置中更换服务密钥',
    ] as const,
    [
      'SomeUnexpectedParameter',
      'MODEL_PROVIDER_ERROR',
      '稍后重试；若持续失败请携带诊断中的服务错误码检查 Provider 配置',
    ] as const,
  ])(
    'HTTP 400 且 provider code %s—归一化—精确错误码与脱敏摘要',
    async (providerCode, expectedCode, expectedAction) => {
      const adapter = new QwenTextModelAdapter({
        credentialId: 'credential-1',
        credentialPort,
        fetch: vi.fn(() =>
          Promise.resolve(
            response(400, {
              error: {
                code: providerCode,
                message: `${providerCode}: request rejected (account/model detail)`,
              },
            }),
          ),
        ),
        workspaceId: 'workspace-123',
      });
      try {
        await adapter.generate(request, new AbortController().signal);
        throw new Error('EXPECTED_FAILURE');
      } catch (error) {
        const failure = adapter.normalizeError(error);
        expect(failure).toMatchObject({
          code: expectedCode,
          providerCode,
          providerMessage: `${providerCode}: request rejected (account/model detail)`,
          providerStatus: 400,
          retryable: false,
          userAction: expectedAction,
        });
        // 归一化错误只允许携带摘要，绝不携带完整响应体。
        expect(JSON.stringify(failure).length).toBeLessThan(600);
      }
    },
  );

  it('HTTP 400 且响应体非 JSON—归一化—退回 MODEL_PROVIDER_ERROR 且无 provider 摘要', async () => {
    const adapter = new QwenTextModelAdapter({
      credentialId: 'credential-1',
      credentialPort,
      fetch: vi.fn(() =>
        Promise.resolve(new Response('<html>bad gateway</html>', { status: 400 })),
      ),
      workspaceId: 'workspace-123',
    });
    try {
      await adapter.generate(request, new AbortController().signal);
      throw new Error('EXPECTED_FAILURE');
    } catch (error) {
      const failure = adapter.normalizeError(error);
      expect(failure).toMatchObject({
        code: 'MODEL_PROVIDER_ERROR',
        providerCode: null,
        providerMessage: null,
        providerStatus: 400,
      });
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

  it('按阶段取超时—SHOT_CONTRACT 300s、常规阶段 120s（image-credential-management D3）', async () => {
    const observed: number[] = [];
    const adapter = new QwenTextModelAdapter({
      credentialId: 'credential-1',
      credentialPort,
      fetch: vi.fn(() =>
        Promise.resolve(
          response(200, {
            choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
          }),
        ),
      ),
      timeoutSignal: (milliseconds) => {
        observed.push(milliseconds);
        return new AbortController().signal;
      },
      workspaceId: 'workspace-123',
    });
    await adapter.generate({ ...request, stage: 'SHOT_CONTRACT' }, new AbortController().signal);
    await adapter.generate(request, new AbortController().signal);
    expect(observed).toEqual([300_000, 120_000]);
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

  it('finish_reason=length 超长截断—截断文本原样返回—由候选契约拒绝并走一次修复（shot-contract-generation §4.3）', async () => {
    // SHOT_CONTRACT 单次生成整集 token 量大；截断的镜头数组 JSON 必然解析失败，
    // 适配器不做截断特判（无结构性变更），统一走 JSON_PARSE → 结构修复一次 → 仍失败 FAILED。
    const truncated = '{"data":{"shots":[{"narrative_purpose":"开场","target_dur';
    const adapter = new QwenTextModelAdapter({
      credentialId: 'credential-1',
      credentialPort,
      fetch: vi.fn(() =>
        Promise.resolve(
          response(200, {
            choices: [{ finish_reason: 'length', message: { content: truncated } }],
          }),
        ),
      ),
      workspaceId: 'workspace-123',
    });
    await expect(adapter.generate(request, new AbortController().signal)).resolves.toMatchObject({
      finishReason: 'length',
      rawText: truncated,
    });
  });
});
