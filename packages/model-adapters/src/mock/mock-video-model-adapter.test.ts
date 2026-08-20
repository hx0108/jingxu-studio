import { describe, expect, it, vi } from 'vitest';

import type { VideoGenerationRequest, VideoResultRef } from '@jingxu/application';

import { createMockModelError } from './mock-text-model-adapter';
import {
  MOCK_VIDEO_MP4_BYTES,
  MockVideoModelAdapter,
  MockVideoModelError,
} from './mock-video-model-adapter';

const request = (invocationId: string): VideoGenerationRequest => ({
  durationSec: 5,
  firstFrame: { bytes: Uint8Array.from([0x89, 0x50]), mimeType: 'image/png' },
  invocationId,
  modelId: 'mock-video-model',
  prompt: '雨巷中的少女走过青石板，中景缓推',
  resolution: { height: 1280, width: 720 },
});

const freshSignal = (): AbortSignal => new AbortController().signal;

const stepError = (code: Parameters<typeof createMockModelError>[0]) =>
  ({
    error: createMockModelError(code),
    kind: 'ERROR',
  }) as const;

describe('MockVideoModelAdapter', () => {
  it('规范短片—ftyp 魔数—全实例字节恒等可复算', async () => {
    // ftyp box：第 4-7 字节 ASCII "ftyp"（与 Seedance 下载嗅探同口径）。
    expect([...MOCK_VIDEO_MP4_BYTES.slice(4, 8)]).toEqual([0x66, 0x74, 0x79, 0x70]);
    expect(MOCK_VIDEO_MP4_BYTES.length).toBeGreaterThan(512);
    const adapter = new MockVideoModelAdapter({ steps: [] });
    await expect(
      adapter.download(refOf('mock-video://seed_a'), freshSignal()),
    ).resolves.toBeDefined();
  });

  it('ASYNC 提交—providerTaskId 按序命名—pendingPolls 递减后 SUCCEEDED 带引用与 usage', async () => {
    const adapter = new MockVideoModelAdapter({
      steps: [{ kind: 'ASYNC', pendingPolls: 2 }, { kind: 'ASYNC' }],
    });
    const first = await adapter.submit(request('invocation_polls'), freshSignal());
    expect(first).toEqual({ kind: 'ASYNC', providerTaskId: 'mock-video-task-1' });

    expect(await adapter.poll('mock-video-task-1', freshSignal())).toEqual({ state: 'PENDING' });
    expect(await adapter.poll('mock-video-task-1', freshSignal())).toEqual({ state: 'PENDING' });
    expect(await adapter.poll('mock-video-task-1', freshSignal())).toEqual({
      result: {
        actualDurationSec: 1,
        height: 1280,
        providerRequestId: 'mock-video-task-1',
        url: 'mock-video://invocation_polls',
        width: 720,
      },
      state: 'SUCCEEDED',
      usage: { generatedImages: null, outputTokens: 96_000 },
    });

    const second = await adapter.submit(request('invocation_immediate'), freshSignal());
    expect(second).toEqual({ kind: 'ASYNC', providerTaskId: 'mock-video-task-2' });
    // 未声明 pendingPolls：首次 poll 即终态。
    const status = await adapter.poll('mock-video-task-2', freshSignal());
    expect(status.state).toBe('SUCCEEDED');
  });

  it('失败矩阵—ERROR 候选级失败/TIMEOUT/poll 期 failureCode/预算外 MODEL_UNKNOWN', async () => {
    const adapter = new MockVideoModelAdapter({
      steps: [
        stepError('MODEL_RATE_LIMITED'),
        { afterMs: 1, kind: 'TIMEOUT' },
        { failureCode: 'MODEL_CONTENT_REJECTED', kind: 'ASYNC' },
      ],
    });
    await expect(adapter.submit(request('invocation_fail'), freshSignal())).rejects.toThrow(
      'MODEL_RATE_LIMITED',
    );
    await expect(adapter.submit(request('invocation_fail'), freshSignal())).rejects.toThrow(
      'MODEL_TIMEOUT',
    );
    const asyncFailed = await adapter.submit(request('invocation_fail'), freshSignal());
    expect(asyncFailed).toEqual({ kind: 'ASYNC', providerTaskId: 'mock-video-task-3' });
    expect(await adapter.poll('mock-video-task-3', freshSignal())).toEqual({
      detail: 'Mock poll outcome: MODEL_CONTENT_REJECTED.',
      errorCode: 'MODEL_CONTENT_REJECTED',
      state: 'FAILED',
    });
    // 步骤预算耗尽：失控循环熔断为候选级 MODEL_UNKNOWN。
    await expect(adapter.submit(request('invocation_fail'), freshSignal())).rejects.toThrow(
      'MODEL_UNKNOWN',
    );
  });

  it('证据通道—失败原文确定性可解析—限流记 429 其余 500—本地失败全 null', async () => {
    const failing = new MockVideoModelAdapter({
      steps: [
        stepError('MODEL_RATE_LIMITED'),
        stepError('MODEL_PROVIDER_ERROR'),
        { kind: 'ASYNC' },
      ],
    });
    const rateError = await failing.submit(request('invocation_rate'), freshSignal()).then(
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
    const providerError = await failing.submit(request('invocation_provider'), freshSignal()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failing.evidenceOf(providerError)).toMatchObject({ httpStatus: 500 });

    const timeoutError = await new MockVideoModelAdapter({
      steps: [{ afterMs: 1, kind: 'TIMEOUT' }],
    })
      .submit(request('invocation_timeout'), freshSignal())
      .then(
        () => null,
        (error: unknown) => error,
      );
    // 无网络交互的本地失败：证据通道为全 null（非 null 对象——与 Seedance 默认证据同形）。
    expect(new MockVideoModelAdapter({ steps: [] }).evidenceOf(timeoutError)).toEqual({
      bodyText: null,
      httpStatus: null,
      truncated: false,
    });
  });

  it('download—本地重放规范 mp4 字节—非法 URL 拒绝—同 seed 字节一致（CAS 合流）', async () => {
    const adapter = new MockVideoModelAdapter({ steps: [{ kind: 'ASYNC' }, { kind: 'ASYNC' }] });
    await adapter.submit(request('invocation_dl_a'), freshSignal());
    await adapter.submit(request('invocation_dl_b'), freshSignal());
    const first = await adapter.poll('mock-video-task-1', freshSignal());
    const second = await adapter.poll('mock-video-task-2', freshSignal());
    if (first.state !== 'SUCCEEDED' || second.state !== 'SUCCEEDED') {
      throw new Error('mock step expected SUCCEEDED');
    }
    const bytesA = await adapter.download(first.result as VideoResultRef, freshSignal());
    const bytesB = await adapter.download(second.result as VideoResultRef, freshSignal());
    expect(bytesA.mimeType).toBe('video/mp4');
    expect(bytesA.bytes).toEqual(MOCK_VIDEO_MP4_BYTES);
    expect(bytesB.bytes).toEqual(bytesA.bytes); // 规范短片恒等：候选行独立、文件合流

    await expect(
      adapter.download(refOf('https://ark-result.example.com/clip.mp4'), freshSignal()),
    ).rejects.toThrow('MODEL_RESULT_UNAVAILABLE');
  });

  it('中止传播—submit 前置拒绝/afterMs 等待期中止/poll/download 中止', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const adapter = new MockVideoModelAdapter({ steps: [{ kind: 'ASYNC' }] });
    await expect(adapter.submit(request('invocation_abort'), aborted.signal)).rejects.toThrow(
      'MODEL_CANCELLED',
    );

    const wait = vi.fn(() =>
      Promise.reject(new MockVideoModelError(createMockModelError('MODEL_CANCELLED'))),
    );
    const slow = new MockVideoModelAdapter({
      steps: [{ afterMs: 800, kind: 'ASYNC' }],
      wait,
    });
    await expect(slow.submit(request('invocation_slow'), freshSignal())).rejects.toThrow(
      'MODEL_CANCELLED',
    );
    expect(wait).toHaveBeenCalledWith(800, expect.anything());

    const submitted = await new MockVideoModelAdapter({ steps: [{ kind: 'ASYNC' }] }).submit(
      request('invocation_abort_poll'),
      freshSignal(),
    );
    if (submitted.kind !== 'ASYNC') throw new Error('mock step expected ASYNC');
    const polling = new MockVideoModelAdapter({ steps: [] });
    await expect(polling.poll(submitted.providerTaskId, aborted.signal)).rejects.toThrow(
      'MODEL_CANCELLED',
    );
    await expect(
      polling.download(refOf('mock-video://invocation_abort_poll'), aborted.signal),
    ).rejects.toThrow('MODEL_CANCELLED');
  });

  it('validateCredential—注入即回显—缺省 ok', async () => {
    await expect(new MockVideoModelAdapter({ steps: [] }).validateCredential()).resolves.toEqual({
      ok: true,
    });
    await expect(
      new MockVideoModelAdapter({
        credentialCheck: { detail: null, errorCode: 'MODEL_CREDENTIAL_INVALID', ok: false },
        steps: [],
      }).validateCredential(),
    ).resolves.toEqual({ detail: null, errorCode: 'MODEL_CREDENTIAL_INVALID', ok: false });
  });
});

const refOf = (url: string): VideoResultRef => ({
  actualDurationSec: 1,
  height: 1280,
  providerRequestId: null,
  url,
  width: 720,
});
