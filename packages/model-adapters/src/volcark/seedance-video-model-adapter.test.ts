import { describe, expect, it, vi } from 'vitest';

import type { Mock } from 'vitest';

import type { CredentialPort, VideoGenerationRequest, VideoResultRef } from '@jingxu/application';

import {
  SEEDANCE_FIRST_FRAME_MAX_BYTES,
  SEEDANCE_MODEL_ID,
  SEEDANCE_MODEL_IDS,
  SeedanceVideoModelAdapter,
} from './seedance-video-model-adapter';

const ARK_KEY = 'ark-test-key-000000';
const VIDEO_URL = 'https://ark-result.tos-cn-beijing.volces.com/clip.mp4';
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
/** mp4 嗅探样例：第 4-7 字节 "ftyp"（ISO BMFF box 头）。 */
const MP4_BYTES = Uint8Array.from([
  0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
]);

type FetchMock = Mock<typeof globalThis.fetch>;

const credentialPort = (failing = false): CredentialPort => ({
  deleteCredential: vi.fn(),
  isAvailable: () => true,
  loadCredential: vi.fn(
    failing ? () => Promise.reject(new Error('missing')) : () => Promise.resolve(ARK_KEY),
  ),
  saveCredential: vi.fn(),
});

const request = (overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest => ({
  durationSec: 5,
  firstFrame: { bytes: PNG_BYTES, mimeType: 'image/png' },
  invocationId: 'invocation_seedance_1',
  modelId: SEEDANCE_MODEL_ID,
  prompt: '雨巷中的少女走过青石板，中景缓推',
  resolution: { height: 1280, width: 720 },
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });

const submitBodyOf = (fetchMock: FetchMock): Record<string, unknown> => {
  const call = fetchMock.mock.calls[0];
  if (call === undefined) return {};
  return JSON.parse(typeof call[1]?.body === 'string' ? call[1].body : '') as Record<
    string,
    unknown
  >;
};

describe('SeedanceVideoModelAdapter', () => {
  it('submit—真 ASYNC：仅返回 providerTaskId—请求体含 content(text+首帧 data URI)/duration/档位', async () => {
    const fetchMock: FetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ id: 'cgt-202608201200000000' })),
    );
    const adapter = new SeedanceVideoModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: fetchMock,
    });
    const submission = await adapter.submit(request(), new AbortController().signal);
    expect(submission).toEqual({ kind: 'ASYNC', providerTaskId: 'cgt-202608201200000000' });

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
    const init = call?.[1] ?? {};
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ARK_KEY}`);
    const body = submitBodyOf(fetchMock);
    expect(Object.keys(body).sort()).toEqual([
      'content',
      'duration',
      'model',
      'ratio',
      'resolution',
      'return_url',
      'watermark',
    ]);
    expect(body.duration).toBe(5);
    expect(body.model).toBe(SEEDANCE_MODEL_ID);
    expect(body.ratio).toBe('adaptive');
    expect(body.resolution).toBe('720p');
    expect(body.return_url).toBe(true);
    expect(body.watermark).toBe(true);
    const content = body.content as
      { image_url?: { url?: unknown }; text?: unknown; type?: unknown }[] | undefined;
    expect(content?.[0]).toEqual({ text: '雨巷中的少女走过青石板，中景缓推', type: 'text' });
    expect(content?.[1]?.type).toBe('image_url');
    // 首帧以 data URI 原样进请求体（atob 逐字节回解比对，不经 Buffer）。
    const dataUri = content?.[1]?.image_url?.url;
    expect(dataUri).toBeTypeOf('string');
    expect(atob(String(dataUri).slice('data:image/png;base64,'.length))).toBe(
      String.fromCharCode(...PNG_BYTES),
    );
  });

  it('submit—分辨率就近 1080p 档—时长/分辨率/首帧越界在本地拒绝且不发请求', async () => {
    const fetchMock: FetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ id: 'cgt-x' })),
    );
    const adapter = new SeedanceVideoModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: fetchMock,
    });
    const tall = await adapter.submit(
      request({ resolution: { height: 1920, width: 1080 } }),
      new AbortController().signal,
    );
    const call = fetchMock.mock.calls[0];
    expect(tall.kind).toBe('ASYNC');
    expect(submitBodyOf(fetchMock).resolution).toBe('1080p');
    expect(call?.[1]?.headers).toBeDefined();

    for (const invalid of [
      request({ durationSec: 3 }),
      request({ durationSec: 15 }),
      request({ resolution: { height: 2000, width: 1000 } }),
      request({ firstFrame: { bytes: PNG_BYTES, mimeType: 'image/avif' } }),
      request({ firstFrame: { bytes: new Uint8Array(0), mimeType: 'image/png' } }),
      request({
        firstFrame: {
          bytes: new Uint8Array(SEEDANCE_FIRST_FRAME_MAX_BYTES + 1),
          mimeType: 'image/png',
        },
      }),
    ]) {
      await expect(adapter.submit(invalid, new AbortController().signal)).rejects.toThrow(
        'MODEL_INPUT_TOO_LARGE',
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('submit—HTTP 状态矩阵归一化与原始留证—normalized 不含 Provider 原文', async () => {
    const cases: readonly [number, string, boolean][] = [
      [401, 'MODEL_CREDENTIAL_INVALID', false],
      [403, 'MODEL_CREDENTIAL_INVALID', false],
      [429, 'MODEL_RATE_LIMITED', true],
      [500, 'MODEL_PROVIDER_ERROR', true],
    ];
    for (const [status, code, retryable] of cases) {
      const adapter = new SeedanceVideoModelAdapter({
        credentialId: 'cred_ark',
        credentialPort: credentialPort(),
        fetch: vi.fn<typeof globalThis.fetch>(() =>
          Promise.resolve(jsonResponse({ error: { code: 'InternalServiceError' } }, status)),
        ),
      });
      const caught = await adapter.submit(request(), new AbortController().signal).then(
        () => null,
        (error: unknown) => error,
      );
      expect(adapter.normalizeError(caught)).toMatchObject({ code, retryable });
      expect(adapter.evidenceOf(caught)).toMatchObject({ httpStatus: status });
      expect(JSON.stringify(adapter.normalizeError(caught))).not.toContain('InternalServiceError');
      expect(JSON.stringify(adapter.evidenceOf(caught))).not.toContain(ARK_KEY);
    }
  });

  it('submit—传输异常归一：超时 MODEL_TIMEOUT—中止 MODEL_CANCELLED', async () => {
    const timeoutAdapter = new SeedanceVideoModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.reject(new DOMException('The operation timed out', 'TimeoutError')),
      ),
    });
    const timeoutError = await timeoutAdapter.submit(request(), new AbortController().signal).then(
      () => null,
      (error: unknown) => error,
    );
    expect(timeoutAdapter.normalizeError(timeoutError)).toMatchObject({
      code: 'MODEL_TIMEOUT',
      retryable: false,
    });

    const abortController = new AbortController();
    abortController.abort();
    const abortAdapter = new SeedanceVideoModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({ id: 'cgt' }))),
    });
    const abortError = await abortAdapter.submit(request(), abortController.signal).then(
      () => null,
      (error: unknown) => error,
    );
    expect(abortAdapter.normalizeError(abortError)).toMatchObject({
      code: 'MODEL_CANCELLED',
      retryable: false,
    });
  });

  it('evidence—超限响应体截断至 64KiB—本地拒绝未发请求证据全 null', async () => {
    const bigAdapter = new SeedanceVideoModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(new Response('x'.repeat(70_000), { status: 500 })),
      ),
    });
    const remoteError = await bigAdapter.submit(request(), new AbortController().signal).then(
      () => null,
      (error: unknown) => error,
    );
    const evidence = bigAdapter.evidenceOf(remoteError);
    expect(evidence).not.toBeNull();
    expect(evidence?.bodyText?.length).toBe(65_536);
    expect(evidence?.truncated).toBe(true);

    const localAdapter = new SeedanceVideoModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({ id: 'cgt' }))),
    });
    const localError = await localAdapter
      .submit(request({ durationSec: 3 }), new AbortController().signal)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(localAdapter.evidenceOf(localError)).toEqual({
      bodyText: null,
      httpStatus: null,
      truncated: false,
    });
  });

  it('poll—queued/running→PENDING—succeeded→引用与 usage—failed→稳定错误码', async () => {
    const adapterFor = (body: unknown): SeedanceVideoModelAdapter =>
      new SeedanceVideoModelAdapter({
        credentialId: 'cred_ark',
        credentialPort: credentialPort(),
        fetch: vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse(body))),
      });
    const signal = new AbortController().signal;

    await expect(
      adapterFor({ id: 'cgt-1', status: 'running' }).poll('cgt-1', signal),
    ).resolves.toEqual({ state: 'PENDING' });
    await expect(
      adapterFor({ id: 'cgt-1', status: 'queued' }).poll('cgt-1', signal),
    ).resolves.toEqual({ state: 'PENDING' });

    const succeeded = await adapterFor({
      content: { video_url: VIDEO_URL },
      id: 'cgt-1',
      status: 'succeeded',
      usage: { completion_tokens: 96000, generated_video_seconds: 5 },
    }).poll('cgt-1', signal);
    expect(succeeded).toEqual({
      result: {
        actualDurationSec: 5,
        height: null,
        providerRequestId: 'cgt-1',
        url: VIDEO_URL,
        width: null,
      },
      state: 'SUCCEEDED',
      usage: { generatedImages: null, outputTokens: 96000 },
    });

    const failed = await adapterFor({
      error: { code: 'content_filter', message: '含敏感词：提示词原文' },
      id: 'cgt-1',
      status: 'failed',
    }).poll('cgt-1', signal);
    expect(failed).toMatchObject({ errorCode: 'MODEL_CONTENT_REJECTED', state: 'FAILED' });

    const cancelled = await adapterFor({ id: 'cgt-1', status: 'cancelled' }).poll('cgt-1', signal);
    expect(cancelled).toMatchObject({ errorCode: 'MODEL_PROVIDER_ERROR', state: 'FAILED' });

    // succeeded 而无 video_url：不伪造引用。
    await expect(
      adapterFor({ id: 'cgt-1', status: 'succeeded' }).poll('cgt-1', signal),
    ).rejects.toThrow('MODEL_INVALID_RESPONSE');
  });

  it('poll—未回报实际时长与未知 usage 字段如实为 null', async () => {
    const adapter = new SeedanceVideoModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
          jsonResponse({ content: { video_url: VIDEO_URL }, id: 'cgt-1', status: 'succeeded' }),
        ),
      ),
    });
    const status = await adapter.poll('cgt-1', new AbortController().signal);
    expect(status.state).toBe('SUCCEEDED');
    if (status.state !== 'SUCCEEDED') return;
    // VideoResultRef 的 actualDurationSec 为运行时扩展（Port 静态类型沿用 ImageResultRef）。
    expect((status.result as VideoResultRef).actualDurationSec).toBeNull();
    expect(status.usage).toEqual({ generatedImages: null, outputTokens: null });
  });

  it('download—mp4 ftyp 嗅探—非 mp4/非 https/非 2xx 归一化拒绝', async () => {
    const okAdapter = new SeedanceVideoModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(MP4_BYTES))),
    });
    const download = await okAdapter.download(
      {
        actualDurationSec: 5,
        height: null,
        providerRequestId: 'cgt-1',
        url: VIDEO_URL,
        width: null,
      },
      new AbortController().signal,
    );
    expect(download.mimeType).toBe('video/mp4');
    expect([...download.bytes.slice(4, 8)]).toEqual([0x66, 0x74, 0x79, 0x70]);

    await expect(
      okAdapter.download(
        {
          actualDurationSec: null,
          height: null,
          providerRequestId: null,
          url: 'http://insecure.example.com/clip.mp4',
          width: null,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('MODEL_RESULT_UNAVAILABLE');

    const notMp4 = new SeedanceVideoModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(PNG_BYTES))),
    });
    await expect(
      notMp4.download(
        {
          actualDurationSec: null,
          height: null,
          providerRequestId: null,
          url: VIDEO_URL,
          width: null,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('MODEL_INVALID_RESPONSE');

    const expired = new SeedanceVideoModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(new Response('gone', { status: 404 })),
      ),
    });
    await expect(
      expired.download(
        {
          actualDurationSec: null,
          height: null,
          providerRequestId: null,
          url: VIDEO_URL,
          width: null,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('MODEL_RESULT_UNAVAILABLE');
  });

  it('model id—非锁定集合在构造期拒绝', () => {
    expect(
      () =>
        new SeedanceVideoModelAdapter({
          credentialId: 'cred_ark',
          credentialPort: credentialPort(),
          modelId: 'doubao-seedance-9-9-fake',
        }),
    ).toThrow('MODEL_CONFIGURATION_INVALID');
    expect(SEEDANCE_MODEL_IDS).toHaveLength(1);
  });

  it('validateCredential—可解密即 ok—失败归一化 CREDENTIAL_INVALID 且不含 Key', async () => {
    const okAdapter = new SeedanceVideoModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(),
    });
    await expect(okAdapter.validateCredential()).resolves.toEqual({ ok: true });

    const failing = new SeedanceVideoModelAdapter({
      credentialId: 'cred_ark',
      credentialPort: credentialPort(true),
    });
    const check = await failing.validateCredential();
    expect(check).toEqual({ detail: null, errorCode: 'MODEL_CREDENTIAL_INVALID', ok: false });
    expect(JSON.stringify(check)).not.toContain(ARK_KEY);
  });
});
