import { describe, expect, it, vi } from 'vitest';

import type { Mock } from 'vitest';

import type { CredentialPort, ImageGenerationRequest } from '@jingxu/application';

import {
  AGNES_IMAGE_2_1_FLASH_MODEL_ID,
  DEFAULT_AGNES_IMAGE_MODEL_ID,
  deriveAgnesImageSize,
} from './agnes-image-models';
import { AgnesImageModelAdapter } from './agnes-image-model-adapter';

const AGNES_KEY = 'agnes-test-key-000000';
/** 2026-09-21 实测输出域（与视频输出同域族）。 */
const RESULT_URL = 'https://platform-outputs.agnes-ai.space/images/t2i/task_x/output.png';

type FetchMock = Mock<typeof globalThis.fetch>;

const credentialPort = (failing = false): CredentialPort => ({
  deleteCredential: vi.fn(),
  isAvailable: () => true,
  loadCredential: vi.fn(
    failing ? () => Promise.reject(new Error('missing')) : () => Promise.resolve(AGNES_KEY),
  ),
  saveCredential: vi.fn(),
});

const request = (overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest => ({
  invocationId: 'invocation_agnes_image_1',
  modelId: DEFAULT_AGNES_IMAGE_MODEL_ID,
  prompt: '午夜列车车厢，冷蓝光，中景',
  referenceImages: [],
  size: { height: 1920, width: 1080 },
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });

/** 实测响应形态：{created, task_id, data:[{url, b64_json:"", revised_prompt:""}]}。 */
const okBody = {
  created: 1789957729,
  data: [{ b64_json: '', revised_prompt: '', url: RESULT_URL }],
  task_id: 'task_bTz4LtvsFh3r1kDXRv3aFcHxRFpNnpbe',
};

const okFetch = (): FetchMock =>
  vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse(okBody)));

const submitBodyOf = (fetchMock: FetchMock): Record<string, unknown> => {
  const call = fetchMock.mock.calls[0];
  if (call === undefined) return {};
  return JSON.parse(typeof call[1]?.body === 'string' ? call[1].body : '') as Record<
    string,
    unknown
  >;
};

const adapterOf = (fetchMock: FetchMock): AgnesImageModelAdapter =>
  new AgnesImageModelAdapter({
    credentialId: 'cred_agnes',
    credentialPort: credentialPort(),
    fetch: fetchMock,
  });

describe('deriveAgnesImageSize', () => {
  it('官方矩阵点全部正确落桶（含 3136×1344 边界归 2K）', () => {
    const cases: readonly [number, number, string, string][] = [
      [1024, 1024, '1K', '1:1'],
      [2048, 2048, '2K', '1:1'],
      [4096, 4096, '4K', '1:1'],
      [1312, 736, '1K', '16:9'],
      [2624, 1472, '2K', '16:9'],
      [5248, 2944, '4K', '16:9'],
      [736, 1312, '1K', '9:16'],
      [1472, 2624, '2K', '9:16'],
      [864, 1152, '1K', '3:4'],
      [3456, 4608, '4K', '3:4'],
      [1568, 672, '1K', '21:9'],
      [3136, 1344, '2K', '21:9'],
    ];
    for (const [width, height, tier, ratio] of cases) {
      expect(deriveAgnesImageSize({ height, width })).toEqual({ ratio, size: tier });
    }
  });

  it('非原生尺寸按像素落桶+对数空间最近邻（1080×1920→2K/9:16）', () => {
    expect(deriveAgnesImageSize({ height: 1920, width: 1080 })).toEqual({
      ratio: '9:16',
      size: '2K',
    });
    // 1920×1080 不是 16:9 的约分形态（8:4.5 约分后 8:4.5→16:9 实际可约：
    // gcd(1920,1080)=120 → 16:9 精确命中）。
    expect(deriveAgnesImageSize({ height: 1080, width: 1920 })).toEqual({
      ratio: '16:9',
      size: '2K',
    });
    // 奇异比例（2.35:1 电影宽幅）→ 21:9 最近邻。
    expect(deriveAgnesImageSize({ height: 816, width: 1920 })).toEqual({
      ratio: '21:9',
      size: '2K',
    });
  });
});

describe('AgnesImageModelAdapter', () => {
  it('submit—同步终态 SYNC 引用—请求体档位/画幅比/嵌套 extra_body 形状', async () => {
    const fetchMock = okFetch();
    const submission = await adapterOf(fetchMock).submit(request(), new AbortController().signal);
    expect(submission).toEqual({
      kind: 'SYNC',
      raw: { bodyText: JSON.stringify(okBody), httpStatus: 200, truncated: false },
      result: { height: null, providerRequestId: okBody.task_id, url: RESULT_URL, width: null },
      usage: { generatedImages: 1, outputTokens: null },
    });
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('https://apihub.agnes-ai.com/v1/images/generations');
    const init = call?.[1] ?? {};
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${AGNES_KEY}`);
    // 1080×1920（9:16 约分精确匹配，2.07MP → 2K 档）；response_format 必须嵌在 extra_body。
    expect(submitBodyOf(fetchMock)).toEqual({
      extra_body: { response_format: 'url' },
      model: 'agnes-image-2.5-flash',
      prompt: '午夜列车车厢，冷蓝光，中景',
      ratio: '9:16',
      size: '2K',
    });
  });

  it('submit—双模型按请求分发—2.1 Flash 同形状仅 model 不同', async () => {
    const fetchMock = okFetch();
    await adapterOf(fetchMock).submit(
      request({ modelId: AGNES_IMAGE_2_1_FLASH_MODEL_ID, size: { height: 1024, width: 1024 } }),
      new AbortController().signal,
    );
    expect(submitBodyOf(fetchMock)).toMatchObject({
      model: 'agnes-image-2.1-flash',
      ratio: '1:1',
      size: '1K',
    });
  });

  it('submit—参考图编码为 dataURI 进 extra_body.image', async () => {
    const fetchMock = okFetch();
    await adapterOf(fetchMock).submit(
      request({ referenceImages: [{ bytes: Uint8Array.from([1, 2, 3]), mimeType: 'image/png' }] }),
      new AbortController().signal,
    );
    expect(submitBodyOf(fetchMock)).toMatchObject({
      extra_body: { image: ['data:image/png;base64,AQID'], response_format: 'url' },
    });
  });

  it('submit—未注册 modelId 即拒—不发请求', async () => {
    const fetchMock = okFetch();
    await expect(
      adapterOf(fetchMock).submit(
        request({ modelId: 'agnes-image-9.9-flash' }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('MODEL_CONFIGURATION_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submit—2xx 但无 url 视为无效响应', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ created: 1, data: [{ b64_json: '', revised_prompt: '' }] })),
    );
    await expect(adapterOf(fetchMock).submit(request(), new AbortController().signal)).rejects.toMatchObject(
      { name: 'AgnesImageAdapterError' },
    );
  });

  it('HTTP 状态矩阵—401 凭据/429 限流可重试/5xx 服务端可重试/404 模型不可用', async () => {
    const cases: readonly [number, string, boolean][] = [
      [401, 'MODEL_CREDENTIAL_INVALID', false],
      [429, 'MODEL_RATE_LIMITED', true],
      [500, 'MODEL_PROVIDER_ERROR', true],
      [503, 'MODEL_PROVIDER_ERROR', true],
      [404, 'MODEL_MODEL_UNAVAILABLE', false],
      [400, 'MODEL_CONTENT_REJECTED', false],
    ];
    for (const [status, code, retryable] of cases) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(jsonResponse({ error: 'boom' }, status)),
      );
      const target = adapterOf(fetchMock);
      const caught: unknown = await target
        .submit(request(), new AbortController().signal)
        .catch((error: unknown) => error);
      expect(caught).toMatchObject({ name: 'AgnesImageAdapterError' });
      expect(target.normalizeError(caught)).toMatchObject({ code, retryable });
      expect(target.evidenceOf(caught)?.httpStatus).toBe(status);
    }
  });

  it('poll—同步语义误用守卫—恒 FAILED/MODEL_UNKNOWN', async () => {
    const polled = await adapterOf(okFetch()).poll();
    expect(polled).toMatchObject({ errorCode: 'MODEL_UNKNOWN', state: 'FAILED' });
    expect(typeof polled.state === 'string' || 'detail' in polled).toBe(true);
  });

  it('download—注册域后缀放行+魔数嗅探；域外/降级 http/userinfo 拒收', async () => {
    const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const okDownload = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(pngBytes, { status: 200 })),
    );
    const downloaded = await adapterOf(okDownload).download(
      { height: null, providerRequestId: null, url: RESULT_URL, width: null },
      new AbortController().signal,
    );
    expect(downloaded).toEqual({ bytes: pngBytes, mimeType: 'image/png' });

    for (const url of [
      'http://platform-outputs.agnes-ai.space/img.png',
      'https://evil.example.com/img.png',
      'https://user:pass@platform-outputs.agnes-ai.space/img.png',
      'https://agnes-ai.space.evil.com/img.png',
    ]) {
      await expect(
        adapterOf(okDownload).download(
          { height: null, providerRequestId: null, url, width: null },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ name: 'AgnesImageAdapterError' });
    }
  });

  it('validateCredential—解密失败归一 CREDENTIAL_INVALID；成功不碰网', async () => {
    await expect(
      new AgnesImageModelAdapter({
        credentialId: 'cred_agnes',
        credentialPort: credentialPort(true),
      }).validateCredential(),
    ).resolves.toEqual({ detail: null, errorCode: 'MODEL_CREDENTIAL_INVALID', ok: false });
    await expect(adapterOf(okFetch()).validateCredential()).resolves.toEqual({ ok: true });
  });
});
