import { describe, expect, it, vi } from 'vitest';

import type {
  CredentialPort,
  NormalizedModelError,
  VideoGenerationRequest,
  VideoResultRef,
} from '@jingxu/application';

import { AgnesVideoModelAdapter } from './agnes-video-model-adapter';
import { AGNES_VIDEO_2_5_FLASH_MODEL_ID, DEFAULT_AGNES_VIDEO_MODEL_ID } from './agnes-video-models';

const credentials: CredentialPort = {
  deleteCredential: vi.fn(),
  isAvailable: () => true,
  loadCredential: vi.fn(() => Promise.resolve('agnes-test-key')),
  saveCredential: vi.fn(),
};

const pngBytes = (size: number): Uint8Array => Uint8Array.from(new Array<number>(size).fill(137));

const request = (overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest => ({
  durationSec: 5,
  firstFrame: { bytes: pngBytes(64), mimeType: 'image/png' },
  invocationId: 'inv_agnes_0001',
  modelId: DEFAULT_AGNES_VIDEO_MODEL_ID,
  prompt: '林夜在霓虹雨巷中缓步前行',
  resolution: { height: 1280, width: 720 },
  ...overrides,
});

const jsonResponse = (payload: unknown, status = 200): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(payload), { status }));

const bodyOf = (init: RequestInit | undefined): Record<string, unknown> => {
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('unexpected request body');
  return JSON.parse(body) as Record<string, unknown>;
};

describe('AgnesVideoModelAdapter', () => {
  it('submit—V2.0 走 image+ti2vid 固定形状，data URL 首帧且不接受调用方扩展参数', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      jsonResponse({ video_id: 'video_agnes_1', task_id: 'task_1' }),
    );
    const adapter = new AgnesVideoModelAdapter({
      credentialId: 'profile-video-agnes-primary',
      credentialPort: credentials,
      fetch,
      modelId: DEFAULT_AGNES_VIDEO_MODEL_ID,
    });

    await expect(adapter.submit(request(), new AbortController().signal)).resolves.toEqual({
      kind: 'ASYNC',
      providerTaskId: 'video_agnes_1',
    });
    const call = fetch.mock.calls[0];
    expect(call?.[0]).toBe('https://apihub.agnes-ai.com/v1/videos');
    expect(call?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer agnes-test-key',
      'Content-Type': 'application/json',
    });
    const body = bodyOf(call?.[1]);
    expect(body.image).toBeTypeOf('string');
    expect((body.image as string).startsWith('data:image/png;base64,')).toBe(true);
    expect(body).toEqual({
      image: body.image,
      mode: 'ti2vid',
      model: 'agnes-video-v2.0',
      prompt: '林夜在霓虹雨巷中缓步前行',
    });
  });

  it('submit—2.5 Flash 走 keyframe+first_frame，显式 5 秒与 720P', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => jsonResponse({ video_id: 'video_agnes_2' }));
    const adapter = new AgnesVideoModelAdapter({
      credentialId: 'profile-video-agnes-primary',
      credentialPort: credentials,
      fetch,
      modelId: AGNES_VIDEO_2_5_FLASH_MODEL_ID,
    });

    await expect(
      adapter.submit(
        request({ modelId: AGNES_VIDEO_2_5_FLASH_MODEL_ID }),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'ASYNC', providerTaskId: 'video_agnes_2' });
    const body = bodyOf(fetch.mock.calls[0]?.[1]);
    expect(body.first_frame).toBeTypeOf('string');
    expect((body.first_frame as string).startsWith('data:image/png;base64,')).toBe(true);
    expect(body).toEqual({
      first_frame: body.first_frame,
      mode: 'keyframe',
      model: 'agnes-video-2.5-flash',
      prompt: '林夜在霓虹雨巷中缓步前行',
      seconds: '5',
      size: '720P',
    });
  });

  it('submit—非 5 秒、非冻结模型、非法 MIME 或超大首帧在网络调用前拒绝；构造期拒绝未知模型', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = new AgnesVideoModelAdapter({
      credentialId: 'profile-video-agnes-primary',
      credentialPort: credentials,
      fetch,
      modelId: DEFAULT_AGNES_VIDEO_MODEL_ID,
    });
    await expect(
      adapter.submit(request({ durationSec: 10 }), new AbortController().signal),
    ).rejects.toThrow('MODEL_INPUT_TOO_LARGE');
    await expect(
      adapter.submit(request({ modelId: 'agnes-video-9.9' }), new AbortController().signal),
    ).rejects.toThrow('MODEL_INPUT_TOO_LARGE');
    await expect(
      adapter.submit(
        request({ firstFrame: { bytes: pngBytes(64), mimeType: 'image/bmp' } }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('MODEL_INPUT_TOO_LARGE');
    await expect(
      adapter.submit(
        request({ firstFrame: { bytes: pngBytes(10 * 1024 * 1024 + 1), mimeType: 'image/png' } }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('MODEL_INPUT_TOO_LARGE');
    expect(fetch).not.toHaveBeenCalled();
    expect(
      () =>
        new AgnesVideoModelAdapter({
          credentialId: 'x',
          credentialPort: credentials,
          fetch,
          modelId: 'agnes-video-9.9' as 'agnes-video-v2.0',
        }),
    ).toThrow('AGNES_MODEL_INVALID');
  });

  it('poll—查询携带 video_id 与 model_name；completed 取顶层 url；pending/queued/in_progress 均为 PENDING', async () => {
    let payload: unknown = { status: 'pending' };
    const fetch = vi.fn<typeof globalThis.fetch>(() => jsonResponse(payload));
    const adapter = new AgnesVideoModelAdapter({
      credentialId: 'profile-video-agnes-primary',
      credentialPort: credentials,
      fetch,
      modelId: DEFAULT_AGNES_VIDEO_MODEL_ID,
    });

    await expect(adapter.poll('video_x', new AbortController().signal)).resolves.toEqual({
      state: 'PENDING',
    });
    payload = { status: 'queued' };
    await expect(adapter.poll('video_x', new AbortController().signal)).resolves.toEqual({
      state: 'PENDING',
    });
    payload = { status: 'in_progress' };
    await expect(adapter.poll('video_x', new AbortController().signal)).resolves.toEqual({
      state: 'PENDING',
    });
    const call = fetch.mock.calls[0];
    expect(call?.[0]).toBe(
      'https://apihub.agnes-ai.com/agnesapi?video_id=video_x&model_name=agnes-video-v2.0',
    );

    payload = {
      seconds: '5.0',
      status: 'completed',
      url: 'https://cos-platform-outputs.agnes-ai.cn/v.mp4',
    };
    await expect(adapter.poll('video_x', new AbortController().signal)).resolves.toEqual({
      result: {
        actualDurationSec: 5,
        height: null,
        providerRequestId: 'video_x',
        url: 'https://cos-platform-outputs.agnes-ai.cn/v.mp4',
        width: null,
      },
      state: 'SUCCEEDED',
      usage: { generatedImages: null, outputTokens: null },
    });
  });

  it('poll—failed 终态；429 归一为可重试限流；completed 缺 url 视为非法响应', async () => {
    let payload: unknown = { error: 'content policy', status: 'failed' };
    let status = 200;
    const fetch = vi.fn<typeof globalThis.fetch>(() => jsonResponse(payload, status));
    const adapter = new AgnesVideoModelAdapter({
      credentialId: 'profile-video-agnes-primary',
      credentialPort: credentials,
      fetch,
      modelId: DEFAULT_AGNES_VIDEO_MODEL_ID,
    });
    await expect(adapter.poll('video_x', new AbortController().signal)).resolves.toEqual({
      detail: null,
      errorCode: 'MODEL_CONTENT_REJECTED',
      state: 'FAILED',
    });

    status = 429;
    payload = { error: { code: 429, message: 'too many video status queries' } };
    await expect(adapter.poll('video_x', new AbortController().signal)).rejects.toThrow(
      'MODEL_RATE_LIMITED',
    );

    status = 200;
    payload = { status: 'completed' };
    await expect(adapter.poll('video_x', new AbortController().signal)).rejects.toThrow(
      'MODEL_INVALID_RESPONSE',
    );
  });

  it('错误矩阵—401 凭据无效、5xx Provider 可重试、SSL 网络错误可重试', async () => {
    let status = 401;
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      jsonResponse({ error: { code: 401, message: 'invalid api key' } }, status),
    );
    const adapter = new AgnesVideoModelAdapter({
      credentialId: 'profile-video-agnes-primary',
      credentialPort: credentials,
      fetch,
      modelId: DEFAULT_AGNES_VIDEO_MODEL_ID,
    });
    await expect(adapter.submit(request(), new AbortController().signal)).rejects.toThrow(
      'MODEL_CREDENTIAL_INVALID',
    );

    status = 502;
    await expect(adapter.submit(request(), new AbortController().signal)).rejects.toThrow(
      'MODEL_PROVIDER_ERROR',
    );

    fetch.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
    await expect(adapter.submit(request(), new AbortController().signal)).rejects.toThrow(
      'MODEL_NETWORK_ERROR',
    );
  });

  it('download—仅接受 Agnes 注册域后缀的 HTTPS 结果并校验 MP4 魔数', async () => {
    const mp4 = Uint8Array.from([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4, 5]);
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(mp4, { status: 200 })),
    );
    const adapter = new AgnesVideoModelAdapter({
      credentialId: 'profile-video-agnes-primary',
      credentialPort: credentials,
      fetch,
      modelId: DEFAULT_AGNES_VIDEO_MODEL_ID,
    });
    const resultRef = {
      actualDurationSec: 5,
      height: 832,
      providerRequestId: 'video_x',
      url: 'https://cos-platform-outputs.agnes-ai.cn/v.mp4',
      width: 1088,
    };
    await expect(adapter.download(resultRef, new AbortController().signal)).resolves.toEqual({
      bytes: mp4,
      mimeType: 'video/mp4',
    });
    await expect(
      adapter.download(
        { ...resultRef, url: 'https://platform-outputs.agnes-ai.space/v.mp4' },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ bytes: mp4, mimeType: 'video/mp4' });

    await expect(
      adapter.download(
        { ...resultRef, url: 'https://evil.example.com/v.mp4' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('MODEL_RESULT_UNAVAILABLE');
    await expect(
      adapter.download(
        { ...resultRef, url: 'https://agnes-ai.cn.evil.com/v.mp4' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('MODEL_RESULT_UNAVAILABLE');
    await expect(
      adapter.download(
        { ...resultRef, url: 'http://cos-platform-outputs.agnes-ai.cn/v.mp4' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('MODEL_RESULT_UNAVAILABLE');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('AgnesVideoModelAdapter 错误矩阵补齐（low-cost 5.7 / design D5b/D6）', () => {
  const MP4 = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]);

  const adapterOf = (
    fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>,
  ): AgnesVideoModelAdapter =>
    new AgnesVideoModelAdapter({
      credentialId: 'profile-video-agnes-primary',
      credentialPort: credentials,
      fetch,
      modelId: DEFAULT_AGNES_VIDEO_MODEL_ID,
    });

  const normalizedOf = async (
    adapter: AgnesVideoModelAdapter,
    work: Promise<unknown>,
  ): Promise<NormalizedModelError> => {
    try {
      await work;
    } catch (error) {
      return adapter.normalizeError(error);
    }
    throw new Error('期望失败但调用成功');
  };

  it('HTTP 状态矩阵—403 凭据、429 免费档限流可重试、404 模型不可用、413/400 参数与内容', async () => {
    const cases: readonly [number, NormalizedModelError['code'], boolean][] = [
      [403, 'MODEL_CREDENTIAL_INVALID', false],
      [429, 'MODEL_RATE_LIMITED', true],
      [404, 'MODEL_MODEL_UNAVAILABLE', false],
      [413, 'MODEL_INPUT_TOO_LARGE', false],
      [400, 'MODEL_CONTENT_REJECTED', false],
    ];
    for (const [status, code, retryable] of cases) {
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'x' }), { status })),
      );
      const adapter = adapterOf(fetch);
      const normalized = await normalizedOf(
        adapter,
        adapter.submit(request(), new AbortController().signal),
      );
      expect(normalized, `HTTP ${String(status)}`).toMatchObject({ code, retryable });
    }
  });

  it('超时/取消—TIMEOUT 与 CANCELLED 不可重试（网络/SSL 可重试已由上文覆盖）', async () => {
    const timeoutReason = new DOMException('信号超时', 'TimeoutError');
    const timedOut = new AgnesVideoModelAdapter({
      credentialId: 'profile-video-agnes-primary',
      credentialPort: credentials,
      fetch: vi.fn<typeof globalThis.fetch>(),
      modelId: DEFAULT_AGNES_VIDEO_MODEL_ID,
      timeoutSignal: () => AbortSignal.abort(timeoutReason),
    });
    const timeoutNormalized = await normalizedOf(
      timedOut,
      timedOut.submit(request(), new AbortController().signal),
    );
    expect(timeoutNormalized).toMatchObject({ code: 'MODEL_TIMEOUT', retryable: false });

    const cancelled = adapterOf(vi.fn<typeof globalThis.fetch>());
    const controller = new AbortController();
    controller.abort(new DOMException('已取消', 'AbortError'));
    const cancelNormalized = await normalizedOf(
      cancelled,
      cancelled.poll('video-001', controller.signal),
    );
    expect(cancelNormalized).toMatchObject({ code: 'MODEL_CANCELLED', retryable: false });
  });

  it('非法 JSON 与文档外轮询状态—INVALID_RESPONSE / RESULT_UNAVAILABLE（不可自动重发）', async () => {
    const badJson = adapterOf(
      vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(new Response('not json', { status: 200 })),
      ),
    );
    const jsonNormalized = await normalizedOf(
      badJson,
      badJson.poll('video-001', new AbortController().signal),
    );
    expect(jsonNormalized).toMatchObject({ code: 'MODEL_INVALID_RESPONSE', retryable: false });

    const weirdState = adapterOf(
      vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
          new Response(JSON.stringify({ status: 'dimension_lost' }), { status: 200 }),
        ),
      ),
    );
    const weirdNormalized = await normalizedOf(
      weirdState,
      weirdState.poll('video-001', new AbortController().signal),
    );
    expect(weirdNormalized).toMatchObject({ code: 'MODEL_RESULT_UNAVAILABLE', retryable: false });
  });

  it('failed 终态分流—内容语义 CONTENT_REJECTED、其余 PROVIDER_ERROR（不切换 Provider）', async () => {
    const contentRejected = adapterOf(
      vi.fn<typeof globalThis.fetch>(() =>
        jsonResponse({ error: 'content policy violation', status: 'failed' }),
      ),
    );
    await expect(
      contentRejected.poll('video-001', new AbortController().signal),
    ).resolves.toMatchObject({ errorCode: 'MODEL_CONTENT_REJECTED', state: 'FAILED' });

    const providerFailed = adapterOf(
      vi.fn<typeof globalThis.fetch>(() =>
        jsonResponse({ error: 'gpu exhausted', status: 'failed' }),
      ),
    );
    await expect(
      providerFailed.poll('video-001', new AbortController().signal),
    ).resolves.toMatchObject({ errorCode: 'MODEL_PROVIDER_ERROR', state: 'FAILED' });
  });

  it('download 补齐—过期/失效结果 URL 归一 RESULT_UNAVAILABLE、MP4 魔数校验', async () => {
    const resultOf = (url: string): VideoResultRef => ({
      actualDurationSec: null,
      height: null,
      providerRequestId: null,
      url,
      width: null,
    });
    const expired = adapterOf(
      vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response('gone', { status: 404 }))),
    );
    const expiredNormalized = await normalizedOf(
      expired,
      expired.download(
        resultOf('https://cos-platform-outputs.agnes-ai.cn/v.mp4'),
        new AbortController().signal,
      ),
    );
    expect(expiredNormalized).toMatchObject({ code: 'MODEL_RESULT_UNAVAILABLE', retryable: false });

    const notMp4 = adapterOf(
      vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(new Response(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))),
      ),
    );
    await expect(
      notMp4.download(
        resultOf('https://platform-outputs.agnes-ai.space/v.mp4'),
        new AbortController().signal,
      ),
    ).rejects.toThrow('MODEL_INVALID_RESPONSE');

    const good = adapterOf(
      vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(MP4))),
    );
    await expect(
      good.download(
        resultOf('https://cos-platform-outputs.agnes-ai.cn/v.mp4'),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ mimeType: 'video/mp4' });
  });
});
