import { describe, expect, it, vi } from 'vitest';

import type { CredentialPort, TtsSynthesisRequest } from '@jingxu/application';

import { QWEN_TTS_MODEL_ID, QwenTtsModelAdapter } from './qwen-tts-model-adapter';

const credentialPort: CredentialPort = {
  deleteCredential: vi.fn(),
  isAvailable: () => true,
  loadCredential: vi.fn(() => Promise.resolve('fake-credential-value')),
  saveCredential: vi.fn(),
};
const request: TtsSynthesisRequest = {
  invocationId: 'invocation-1',
  modelId: QWEN_TTS_MODEL_ID,
  spokenText: '你好镜序',
  voiceId: 'Neil',
};
/** 最小 RIFF/WAVE 头（魔数 + 尾随字节）；适配器只验魔数不解析全长。 */
const wavBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41]);

describe('QwenTtsModelAdapter', () => {
  it('成功链路—POST 原生路由 + GET OSS url 交付 RIFF 字节与用量', async () => {
    const calls: { init: RequestInit | undefined; url: string }[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({ init, url });
      return Promise.resolve(
        url.includes('multimodal-generation')
          ? new Response(
              JSON.stringify({
                output: {
                  audio: { id: 'audio_provider-request-1', url: 'http://oss.example.com/a.wav' },
                  finish_reason: 'stop',
                },
                request_id: 'provider-request-1',
                usage: { characters: 8 },
              }),
              { headers: { 'content-type': 'application/json' }, status: 200 },
            )
          : new Response(wavBytes, { headers: { 'content-type': 'audio/x-wav' }, status: 200 }),
      );
    };
    const adapter = new QwenTtsModelAdapter({
      credentialId: 'credential-1',
      credentialPort,
      fetch,
    });
    const result = await adapter.synthesize(request, new AbortController().signal);
    expect(result.audio.bytes).toEqual(wavBytes);
    expect(result.audio.mimeType).toBe('audio/wav');
    expect(result.httpStatus).toBe(200);
    expect(result.providerRequestId).toBe('audio_provider-request-1');
    expect(result.usage).toEqual({ outputCharacters: 8, outputTokens: null });
    expect(calls[1]?.url).toBe('http://oss.example.com/a.wav');

    const { init, url } = calls[0] ?? { init: undefined, url: '' };
    expect(url).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    );
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer fake-credential-value' });
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      input: { text: '你好镜序', voice: 'Neil' },
      model: QWEN_TTS_MODEL_ID,
    });
  });

  it.each([
    ['超限文本', 'a'.repeat(601), 'MODEL_INPUT_TOO_LARGE'],
    ['空白文本', '   ', 'MODEL_CONTENT_REJECTED'],
  ])('%s—本地拒绝且不调用网络（Provider 不见非法请求）', async (_, text, code) => {
    const fetch = vi.fn();
    const adapter = new QwenTtsModelAdapter({
      credentialId: 'credential-1',
      credentialPort,
      fetch,
    });
    const error = await adapter
      .synthesize({ ...request, spokenText: text }, new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(adapter.normalizeError(error).code).toBe(code);
    expect(fetch).not.toHaveBeenCalled();
    expect(adapter.evidenceOf(error)).toEqual({
      bodyText: null,
      httpStatus: null,
      truncated: false,
    });
  });

  it('400 音色/文本错误体—MODEL_CONTENT_REJECTED 且证据留存原始响应', async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: 'InvalidParameter',
            message: "<400> InternalError.Algo.InvalidParameter: Voice 'probe' is not supported.",
            request_id: 'req-400',
          }),
          { status: 400 },
        ),
      );
    const adapter = new QwenTtsModelAdapter({
      credentialId: 'credential-1',
      credentialPort,
      fetch,
    });
    const error = await adapter
      .synthesize(request, new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(adapter.normalizeError(error)).toMatchObject({ code: 'MODEL_CONTENT_REJECTED' });
    expect(adapter.evidenceOf(error)).toMatchObject({ httpStatus: 400 });
  });

  it('url 缺失—MODEL_INVALID_RESPONSE', async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ output: { audio: {} }, request_id: 'r1' }), { status: 200 }),
      );
    const adapter = new QwenTtsModelAdapter({
      credentialId: 'credential-1',
      credentialPort,
      fetch,
    });
    const error = await adapter
      .synthesize(request, new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(adapter.normalizeError(error).code).toBe('MODEL_INVALID_RESPONSE');
  });

  it('下载段非 RIFF 字节—MODEL_INVALID_RESPONSE 且证据记 GET 状态', async () => {
    const fetch: typeof globalThis.fetch = (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      return Promise.resolve(
        url.includes('multimodal-generation')
          ? new Response(
              JSON.stringify({
                output: { audio: { id: 'audio_r2', url: 'http://oss.example.com/b.wav' } },
                request_id: 'r2',
              }),
              { status: 200 },
            )
          : new Response(new Uint8Array([0x00, 0x01, 0x02]), { status: 200 }),
      );
    };
    const adapter = new QwenTtsModelAdapter({
      credentialId: 'credential-1',
      credentialPort,
      fetch,
    });
    const error = await adapter
      .synthesize(request, new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(adapter.normalizeError(error).code).toBe('MODEL_INVALID_RESPONSE');
    expect(adapter.evidenceOf(error)).toEqual({
      bodyText: null,
      httpStatus: 200,
      truncated: false,
    });
  });

  it('网络异常归一化—AbortError 取消 / TimeoutError 超时 / 其余可重试网络错误', async () => {
    const cases: [string, Error, string][] = [
      ['AbortError', new DOMException('aborted', 'AbortError'), 'MODEL_CANCELLED'],
      ['TimeoutError', new DOMException('timeout', 'TimeoutError'), 'MODEL_TIMEOUT'],
      ['TypeError', new TypeError('fetch failed'), 'MODEL_NETWORK_ERROR'],
    ];
    for (const [, rejection, code] of cases) {
      const fetch: typeof globalThis.fetch = () => Promise.reject(rejection);
      const adapter = new QwenTtsModelAdapter({
        credentialId: 'credential-1',
        credentialPort,
        fetch,
      });
      const error = await adapter
        .synthesize(request, new AbortController().signal)
        .catch((caught: unknown) => caught);
      expect(adapter.normalizeError(error)).toMatchObject({ code });
    }
  });

  it('401—MODEL_CREDENTIAL_INVALID', async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(new Response('{"code":"InvalidApiKey"}', { status: 401 }));
    const adapter = new QwenTtsModelAdapter({
      credentialId: 'credential-1',
      credentialPort,
      fetch,
    });
    const error = await adapter
      .synthesize(request, new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(adapter.normalizeError(error)).toMatchObject({
      code: 'MODEL_CREDENTIAL_INVALID',
      retryable: false,
    });
  });

  it('validateCredential—零计费仅解密加载，不触网络', async () => {
    const fetch = vi.fn();
    const adapter = new QwenTtsModelAdapter({
      credentialId: 'credential-1',
      credentialPort,
      fetch,
    });
    await expect(adapter.validateCredential()).resolves.toEqual({ ok: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('漂移模型—配置拒绝', () => {
    expect(
      () =>
        new QwenTtsModelAdapter({
          credentialId: 'credential-1',
          credentialPort,
          fetch: vi.fn(),
          modelId: 'qwen3-tts-flash',
        }),
    ).toThrow('MODEL_CONFIGURATION_INVALID');
  });
});
