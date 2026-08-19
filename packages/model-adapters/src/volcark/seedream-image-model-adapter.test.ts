import { describe, expect, it, vi } from 'vitest';

import type { Mock } from 'vitest';

import type { CredentialPort, ImageGenerationRequest, ImageResultRef } from '@jingxu/application';

import {
  SEEDREAM_MODEL_ID,
  SEEDREAM_MODEL_IDS,
  SeedreamImageModelAdapter,
} from './seedream-image-model-adapter';

const ARK_KEY = 'ark-test-key-000000';
const RESULT_URL = 'https://ark-result.tos-cn-beijing.volces.com/img.png';

type FetchMock = Mock<typeof globalThis.fetch>;

const credentialPort = (failing = false): CredentialPort => ({
  deleteCredential: vi.fn(),
  isAvailable: () => true,
  loadCredential: vi.fn(
    failing ? () => Promise.reject(new Error('missing')) : () => Promise.resolve(ARK_KEY),
  ),
  saveCredential: vi.fn(),
});

/** 快照合法区间内的 2048×1800（3,686,400 像素，恰好下界）。 */
const request = (overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest => ({
  invocationId: 'invocation_seedream_1',
  modelId: SEEDREAM_MODEL_ID,
  prompt: '雨巷中的少女，中景，电影感',
  referenceImages: [],
  size: { height: 1800, width: 2048 },
  ...overrides,
});

const resultRef = (): ImageResultRef => ({
  height: 1800,
  providerRequestId: 'resp_123',
  url: RESULT_URL,
  width: 2048,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });

const okBody = {
  data: [{ size: { height: 1800, width: 2048 }, url: RESULT_URL }],
  id: 'resp_123',
  usage: { generated_images: 1, output_tokens: 14400 },
};

const okFetch = (): FetchMock =>
  vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse(okBody)));

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const submitBodyOf = (fetchMock: FetchMock): Record<string, unknown> => {
  const call = fetchMock.mock.calls[0];
  if (call === undefined) return {};
  return JSON.parse(typeof call[1]?.body === 'string' ? call[1].body : '') as Record<
    string,
    unknown
  >;
};

describe('SeedreamImageModelAdapter', () => {
  it('submit—同步终态 SYNC 引用与 usage—请求体只含快照参数', async () => {
    const fetchMock = okFetch();
    const adapter = new SeedreamImageModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: fetchMock,
    });
    const submission = await adapter.submit(request(), new AbortController().signal);
    expect(submission).toEqual({
      kind: 'SYNC',
      result: {
        height: 1800,
        providerRequestId: 'resp_123',
        url: RESULT_URL,
        width: 2048,
      },
      usage: { generatedImages: 1, outputTokens: 14400 },
    });
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
    const init = call?.[1] ?? {};
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ARK_KEY}`);
    expect(submitBodyOf(fetchMock)).toEqual({
      model: 'doubao-seedream-5-0-lite-260128',
      prompt: '雨巷中的少女，中景，电影感',
      response_format: 'url',
      size: '2048x1800',
      watermark: true,
    });
  });

  it('submit—官方 size 为 "WxH" 字符串时解析宽高—畸形字符串降级 null', async () => {
    const stringSizeFetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ ...okBody, data: [{ size: '2560x1440', url: RESULT_URL }] })),
    );
    const adapter = new SeedreamImageModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: stringSizeFetch,
    });
    const submission = await adapter.submit(request(), new AbortController().signal);
    expect(submission.kind).toBe('SYNC');
    if (submission.kind !== 'SYNC') return;
    expect(submission.result.height).toBe(1440);
    expect(submission.result.width).toBe(2560);

    const malformedFetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ ...okBody, data: [{ size: 'large', url: RESULT_URL }] })),
    );
    const malformed = await new SeedreamImageModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: malformedFetch,
    }).submit(request(), new AbortController().signal);
    expect(malformed.kind).toBe('SYNC');
    if (malformed.kind !== 'SYNC') return;
    expect(malformed.result.height).toBeNull();
    expect(malformed.result.width).toBeNull();
  });

  it('submit—参考图编码为 data URI 且非法 mime/超张数被拒', async () => {
    const fetchMock = okFetch();
    const adapter = new SeedreamImageModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: fetchMock,
    });
    await adapter.submit(
      request({ referenceImages: [{ bytes: PNG_BYTES, mimeType: 'image/png' }] }),
      new AbortController().signal,
    );
    const image = submitBodyOf(fetchMock).image as string[];
    expect(image).toHaveLength(1);
    expect(image[0]?.startsWith('data:image/png;base64,')).toBe(true);
    const decoded = atob((image[0] ?? '').slice('data:image/png;base64,'.length));
    expect(decoded.length).toBe(PNG_BYTES.length);
    expect(decoded.charCodeAt(0)).toBe(0x89);
    expect(decoded.charCodeAt(1)).toBe(0x50);

    await expect(
      adapter.submit(
        request({ referenceImages: [{ bytes: PNG_BYTES, mimeType: 'image/avif' }] }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('MODEL_INPUT_TOO_LARGE');
    await expect(
      adapter.submit(
        request({
          referenceImages: Array.from({ length: 15 }, () => ({
            bytes: PNG_BYTES,
            mimeType: 'image/png',
          })),
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('MODEL_INPUT_TOO_LARGE');
  });

  it('submit—HTTP 状态矩阵归一化—逐项失败只传播稳定错误码', async () => {
    const rateLimitedAdapter = new SeedreamImageModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({}, 429))),
    });
    const rateLimited = await rateLimitedAdapter
      .submit(request(), new AbortController().signal)
      .catch((error: unknown) => rateLimitedAdapter.normalizeError(error));
    expect(rateLimited).toMatchObject({ code: 'MODEL_RATE_LIMITED', retryable: true });

    const unauthorized = new SeedreamImageModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({}, 401))),
    });
    await expect(unauthorized.submit(request(), new AbortController().signal)).rejects.toThrow(
      'MODEL_CREDENTIAL_INVALID',
    );

    const partial = new SeedreamImageModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
          jsonResponse({
            data: [{ error: { code: 'content_filter', message: '含敏感词：用户提示词原文' } }],
          }),
        ),
      ),
    });
    const rejected = await partial
      .submit(request(), new AbortController().signal)
      .catch((error: unknown) => partial.normalizeError(error));
    expect(rejected).toMatchObject({ code: 'MODEL_CONTENT_REJECTED' });
    expect(JSON.stringify(rejected)).not.toContain('敏感词');
  });

  it('submit—size 界外与凭据缺失被拒—不发起请求', async () => {
    const fetchMock = okFetch();
    const adapter = new SeedreamImageModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: fetchMock,
    });
    await expect(
      adapter.submit(request({ size: { height: 100, width: 100 } }), new AbortController().signal),
    ).rejects.toThrow('MODEL_INPUT_TOO_LARGE');
    await expect(
      adapter.submit(
        request({ size: { height: 5000, width: 5000 } }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('MODEL_INPUT_TOO_LARGE');
    expect(fetchMock).not.toHaveBeenCalled();

    const noKey = new SeedreamImageModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(true),
      fetch: fetchMock,
    });
    await expect(noKey.submit(request(), new AbortController().signal)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('model id—非 0.2 锁定集合在构造期拒绝', () => {
    expect(
      () =>
        new SeedreamImageModelAdapter({
          credentialId: 'cred_ark',
          credentialPort: credentialPort(),
          modelId: 'doubao-seedream-9-9-fake',
        }),
    ).toThrow('MODEL_CONFIGURATION_INVALID');
    expect(SEEDREAM_MODEL_IDS).toHaveLength(4);
  });

  it('poll—同步语义误用归一化 FAILED 而不伪造引用', async () => {
    const adapter = new SeedreamImageModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
    });
    await expect(adapter.poll()).resolves.toEqual({
      detail: 'Seedream 为同步语义：submit 已返回终态引用，不存在可轮询任务。',
      errorCode: 'MODEL_UNKNOWN',
      state: 'FAILED',
    });
  });

  it('download—https 结果 URL 字节嗅探—非法协议与非 2xx 归一化 MODEL_RESULT_UNAVAILABLE', async () => {
    const adapter = new SeedreamImageModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(PNG_BYTES))),
    });
    const download = await adapter.download(resultRef(), new AbortController().signal);
    expect(download.mimeType).toBe('image/png');
    expect([...download.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    await expect(
      adapter.download(
        { height: 1, providerRequestId: null, url: 'http://insecure.example.com/x.png', width: 1 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('MODEL_RESULT_UNAVAILABLE');

    const expired = new SeedreamImageModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(new Response('gone', { status: 404 })),
      ),
    });
    await expect(expired.download(resultRef(), new AbortController().signal)).rejects.toThrow(
      'MODEL_RESULT_UNAVAILABLE',
    );
  });

  it('validateCredential—可解密即 ok—失败归一化 CREDENTIAL_INVALID 且不含 Key', async () => {
    const okAdapter = new SeedreamImageModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
    });
    await expect(okAdapter.validateCredential()).resolves.toEqual({ ok: true });

    const failing = new SeedreamImageModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(true),
    });
    const check = await failing.validateCredential();
    expect(check).toEqual({ detail: null, errorCode: 'MODEL_CREDENTIAL_INVALID', ok: false });
    expect(JSON.stringify(check)).not.toContain(ARK_KEY);
  });
});
