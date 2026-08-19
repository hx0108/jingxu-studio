import { describe, expect, it, vi } from 'vitest';

import type { ImageGenerationRequest, ImageResultRef } from '@jingxu/application';

import { createMockModelError } from './mock-text-model-adapter';
import { encodeMockPng, MockImageModelAdapter } from './mock-image-model-adapter';

const request = (invocationId: string): ImageGenerationRequest => ({
  invocationId,
  modelId: 'mock-image-model',
  prompt: '雨巷中的少女，中景',
  referenceImages: [],
  size: { height: 8, width: 12 },
});

const freshSignal = (): AbortSignal => new AbortController().signal;

const stepError = (code: Parameters<typeof createMockModelError>[0]) =>
  ({
    error: createMockModelError(code),
    kind: 'ERROR',
  }) as const;

describe('MockImageModelAdapter', () => {
  it('确定性 PNG—同种子字节稳定—结构为合法 PNG 签名/IHDR/IEND', () => {
    const first = encodeMockPng('invocation_seed_a', 12, 8);
    const second = encodeMockPng('invocation_seed_a', 12, 8);
    expect(first).toEqual(second);
    expect([...first.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR 宽高（字节 16..24，大端）。
    const width =
      (first[16] ?? 0) * 0x1000000 +
      (first[17] ?? 0) * 0x10000 +
      (first[18] ?? 0) * 0x100 +
      (first[19] ?? 0);
    const height =
      (first[20] ?? 0) * 0x1000000 +
      (first[21] ?? 0) * 0x10000 +
      (first[22] ?? 0) * 0x100 +
      (first[23] ?? 0);
    expect(width).toBe(12);
    expect(height).toBe(8);
    expect([...first.slice(-8, -4)]).toEqual([...new TextEncoder().encode('IEND')]);
    // 不同种子产生不同字节。
    expect(encodeMockPng('invocation_seed_b', 12, 8)).not.toEqual(first);
  });

  it('SYNC 提交—返回终态引用与 usage—download 本地重放同种子字节', async () => {
    const adapter = new MockImageModelAdapter({ now: () => 1_000, steps: [{ kind: 'SYNC' }] });
    const submission = await adapter.submit(request('invocation_sync'), freshSignal());
    expect(submission.kind).toBe('SYNC');
    if (submission.kind !== 'SYNC') return;
    expect(submission.usage).toEqual({ generatedImages: 1, outputTokens: null });
    expect(submission.result).toMatchObject({
      height: 8,
      providerRequestId: 'mock-image-request-1000-1',
      url: 'mock-image://12x8/invocation_sync',
      width: 12,
    });
    const download = await adapter.download(submission.result, freshSignal());
    expect(download.mimeType).toBe('image/png');
    expect(download.bytes).toEqual(encodeMockPng('invocation_sync', 12, 8));
  });

  it('失败矩阵—网络/限流/审核拒绝/超时各自归一化抛出', async () => {
    const adapter = new MockImageModelAdapter({
      steps: [
        stepError('MODEL_NETWORK_ERROR'),
        stepError('MODEL_RATE_LIMITED'),
        stepError('MODEL_CONTENT_REJECTED'),
        { afterMs: 1, kind: 'TIMEOUT' },
      ],
    });
    const expected: string[] = [
      'MODEL_NETWORK_ERROR',
      'MODEL_RATE_LIMITED',
      'MODEL_CONTENT_REJECTED',
      'MODEL_TIMEOUT',
    ];
    for (const code of expected) {
      await expect(adapter.submit(request('invocation_fail'), freshSignal())).rejects.toThrow(code);
    }
  });

  it('证据通道—SYNC raw 与失败原文确定性且可解析—限流记 429 其余 500', async () => {
    const sync = new MockImageModelAdapter({ now: () => 1_000, steps: [{ kind: 'SYNC' }] });
    const submission = await sync.submit(request('invocation_evidence'), freshSignal());
    expect(submission.kind).toBe('SYNC');
    if (submission.kind !== 'SYNC') return;
    expect(submission.raw.httpStatus).toBe(200);
    expect(submission.raw.truncated).toBe(false);
    const parsed = JSON.parse(submission.raw.bodyText) as {
      data: { size: string; url: string }[];
      id: string;
      usage: { generated_images: number; output_tokens: null };
    };
    expect(parsed).toEqual({
      data: [{ size: '12x8', url: 'mock-image://12x8/invocation_evidence' }],
      id: 'mock-image-request-1000-1',
      usage: { generated_images: 1, output_tokens: null },
    });

    const failing = new MockImageModelAdapter({
      steps: [stepError('MODEL_RATE_LIMITED'), stepError('MODEL_PROVIDER_ERROR')],
    });
    const rateError = await failing
      .submit(request('invocation_rate'), freshSignal())
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failing.evidenceOf(rateError)).toEqual({
      bodyText: JSON.stringify({
        error: { code: 'MODEL_RATE_LIMITED', invocation: 'invocation_rate' },
      }),
      httpStatus: 429,
      truncated: false,
    });
    const providerError = await failing
      .submit(request('invocation_provider'), freshSignal())
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failing.evidenceOf(providerError)).toMatchObject({ httpStatus: 500 });
    // 无响应的本地失败（取消/超时/步骤耗尽）与非本适配器错误证据为 null。
    const cancelled = new MockImageModelAdapter({ steps: [{ kind: 'SYNC' }] });
    const cancelError = await cancelled
      .submit(request('invocation_cancel'), AbortSignal.abort())
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(cancelled.evidenceOf(cancelError)).toEqual({
      bodyText: null,
      httpStatus: null,
      truncated: false,
    });
    expect(failing.evidenceOf(new Error('unrelated'))).toBeNull();
  });

  it('ASYNC 提交—poll 抖动两次 PENDING 后终态—失败形态带 errorCode', async () => {
    const adapter = new MockImageModelAdapter({
      steps: [
        { kind: 'ASYNC', pendingPolls: 2 },
        { failureCode: 'MODEL_TIMEOUT', kind: 'ASYNC' },
      ],
    });
    const submission = await adapter.submit(request('invocation_async'), freshSignal());
    expect(submission).toMatchObject({ kind: 'ASYNC', providerTaskId: 'mock-image-task-1' });
    if (submission.kind !== 'ASYNC') return;
    await expect(adapter.poll(submission.providerTaskId, freshSignal())).resolves.toEqual({
      state: 'PENDING',
    });
    await expect(adapter.poll(submission.providerTaskId, freshSignal())).resolves.toEqual({
      state: 'PENDING',
    });
    const done = await adapter.poll(submission.providerTaskId, freshSignal());
    expect(done).toMatchObject({ state: 'SUCCEEDED' });
    if (done.state !== 'SUCCEEDED') return;
    expect(done.result.url).toBe('mock-image://12x8/invocation_async');
    expect((await adapter.download(done.result, freshSignal())).bytes).toEqual(
      encodeMockPng('invocation_async', 12, 8),
    );

    const failing = await adapter.submit(request('invocation_async_fail'), freshSignal());
    expect(failing.kind).toBe('ASYNC');
    if (failing.kind !== 'ASYNC') return;
    await expect(adapter.poll(failing.providerTaskId, freshSignal())).resolves.toMatchObject({
      errorCode: 'MODEL_TIMEOUT',
      state: 'FAILED',
    });
  });

  it('部分候选失败—步骤序列逐次消耗—耗尽后 MODEL_UNKNOWN', async () => {
    const adapter = new MockImageModelAdapter({
      steps: [
        { kind: 'SYNC' },
        stepError('MODEL_RATE_LIMITED'),
        stepError('MODEL_CONTENT_REJECTED'),
        { kind: 'SYNC' },
      ],
    });
    const outcomes: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      try {
        const submission = await adapter.submit(
          request(`invocation_mix_${String(index)}`),
          freshSignal(),
        );
        outcomes.push(submission.kind === 'SYNC' ? 'SUCCEEDED' : 'ASYNC');
      } catch (error) {
        outcomes.push(adapter.normalizeError(error).code);
      }
    }
    expect(outcomes).toEqual([
      'SUCCEEDED',
      'MODEL_RATE_LIMITED',
      'MODEL_CONTENT_REJECTED',
      'SUCCEEDED',
    ]);
    await expect(adapter.submit(request('invocation_extra'), freshSignal())).rejects.toThrow(
      'MODEL_UNKNOWN',
    );
  });

  it('取消—submit/poll/download 对已中止 signal 归一化 MODEL_CANCELLED', async () => {
    const adapter = new MockImageModelAdapter({ steps: [{ kind: 'SYNC' }] });
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.submit(request('invocation_cancel'), controller.signal)).rejects.toThrow(
      'MODEL_CANCELLED',
    );
    await expect(adapter.poll('mock-image-task-1', controller.signal)).rejects.toThrow(
      'MODEL_CANCELLED',
    );
    await expect(
      adapter.download(
        { height: 8, providerRequestId: null, url: 'mock-image://12x8/x', width: 12 },
        controller.signal,
      ),
    ).rejects.toThrow('MODEL_CANCELLED');
  });

  it('下载 URL 非法—归一化 MODEL_RESULT_UNAVAILABLE', async () => {
    const adapter = new MockImageModelAdapter({ steps: [{ kind: 'SYNC' }] });
    const badRef: ImageResultRef = {
      height: 8,
      providerRequestId: null,
      url: 'https://example.com/leak.png',
      width: 12,
    };
    await expect(adapter.download(badRef, freshSignal())).rejects.toThrow(
      'MODEL_RESULT_UNAVAILABLE',
    );
  });

  it('不触网断言—submit/poll/download 全程零 fetch 调用', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const adapter = new MockImageModelAdapter({ steps: [{ kind: 'ASYNC', pendingPolls: 1 }] });
    const submission = await adapter.submit(request('invocation_offline'), freshSignal());
    if (submission.kind === 'ASYNC') {
      await adapter.poll(submission.providerTaskId, freshSignal());
      const done = await adapter.poll(submission.providerTaskId, freshSignal());
      if (done.state === 'SUCCEEDED') {
        await adapter.download(done.result, freshSignal());
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
