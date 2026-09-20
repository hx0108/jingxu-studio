import { describe, expect, it, vi } from 'vitest';

import type {
  CredentialPort,
  ModelCallEvidence,
  NormalizedModelError,
  VideoGenerationRequest,
  VideoModelPort,
  VideoResultRef,
} from '@jingxu/application';

import { AgnesVideoModelAdapter } from './agnes/agnes-video-model-adapter';
import { DEFAULT_AGNES_VIDEO_MODEL_ID } from './agnes/agnes-video-models';
import { MockVideoModelAdapter } from './mock/mock-video-model-adapter';
import { SeedanceVideoModelAdapter } from './volcark/seedance-video-model-adapter';
import { SEEDANCE_VIDEO_MODELS } from './volcark/seedance-video-models';

/**
 * 通用 VideoModelPort 契约（low-cost 任务 5.4）：三个视频 Adapter（Seedance/Mock/
 * Agnes）在同一 Port 形状下行为一致——submit 恒 ASYNC、poll 映射共享状态联合、
 * download 校验 MP4 魔数、错误经 normalizeError 归一且 evidenceOf 只暴露有界证据；
 * Provider 专有 DTO（原始响应、任务对象、凭据）不得越过 Adapter 公开方法面。
 */

const MP4 = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]);

const credentials: CredentialPort = {
  deleteCredential: vi.fn(),
  isAvailable: () => true,
  loadCredential: vi.fn(() => Promise.resolve('contract-test-key')),
  saveCredential: vi.fn(),
};

const isFtypMp4 = (bytes: Uint8Array): boolean =>
  bytes.length >= 12 &&
  bytes[4] === 0x66 &&
  bytes[5] === 0x74 &&
  bytes[6] === 0x79 &&
  bytes[7] === 0x70;

interface Fixture {
  readonly adapter: VideoModelPort;
  /** Provider 侧轮询状态切换（首答进行中、次答成功）。 */
  readonly advanceToSucceeded: () => void;
  readonly request: VideoGenerationRequest;
}

/** fetch 入参（RequestInfo | URL）安全取字符串 URL（Request.url / URL.href）。 */
const urlOf = (input: Parameters<typeof globalThis.fetch>[0]): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status });

const fixtureOf = (name: 'AGNES' | 'MOCK' | 'SEEDANCE'): Fixture => {
  const request: VideoGenerationRequest = {
    durationSec: 5,
    firstFrame: { bytes: Uint8Array.from([137, 80, 78, 71]), mimeType: 'image/png' },
    invocationId: 'inv_contract_0001',
    modelId: name === 'AGNES' ? DEFAULT_AGNES_VIDEO_MODEL_ID : SEEDANCE_VIDEO_MODELS[2].id,
    prompt: '雨巷中人物缓步前行',
    resolution: { height: 1280, width: 720 },
  };
  if (name === 'MOCK') {
    return {
      adapter: new MockVideoModelAdapter({ steps: [{ kind: 'ASYNC', pendingPolls: 1 }] }),
      advanceToSucceeded: () => undefined,
      request,
    };
  }
  let polled = false;
  const advanceToSucceeded = (): void => {
    polled = true;
  };
  const respond = (url: string): Response => {
    if (url.includes('/v1/videos')) {
      // 建任务：Agnes video_id。
      return jsonResponse({ video_id: 'vid-contract-1' });
    }
    if (url.includes('/agnesapi')) {
      if (!polled) return jsonResponse({ status: 'queued' });
      return jsonResponse({
        request_id: 'req-1',
        seconds: '5',
        status: 'completed',
        url: 'https://cos-platform-outputs.agnes-ai.cn/v.mp4',
      });
    }
    // 结果下载（Agnes 注册域）。
    return new Response(MP4);
  };
  const fetch = vi.fn<typeof globalThis.fetch>((input) => Promise.resolve(respond(urlOf(input))));
  const adapter = new AgnesVideoModelAdapter({
    credentialId: 'profile-video-agnes-primary',
    credentialPort: credentials,
    fetch,
    modelId: DEFAULT_AGNES_VIDEO_MODEL_ID,
  });
  return { adapter, advanceToSucceeded, request };
};

const seedanceFixture = (): Fixture => {
  let polled = false;
  const fetch = vi.fn<typeof globalThis.fetch>((input) => {
    const url = urlOf(input);
    if (url.endsWith('/tasks')) {
      return Promise.resolve(jsonResponse({ id: 'cgt-contract-1' }));
    }
    if (url.includes('/tasks/')) {
      if (!polled) return Promise.resolve(jsonResponse({ id: 'cgt-1', status: 'running' }));
      return Promise.resolve(
        jsonResponse({
          id: 'cgt-contract-1',
          status: 'succeeded',
          content: { video_url: 'https://ark.example/v.mp4' },
          usage: { completion_tokens: 9, generated_video_seconds: 5 },
        }),
      );
    }
    return Promise.resolve(new Response(MP4));
  });
  return {
    adapter: new SeedanceVideoModelAdapter({
      baseUrl: 'https://ark.example',
      credentialId: 'profile-video-primary',
      credentialPort: credentials,
      fetch,
    }),
    advanceToSucceeded: () => {
      polled = true;
    },
    request: {
      durationSec: 5,
      firstFrame: { bytes: Uint8Array.from([137, 80, 78, 71]), mimeType: 'image/png' },
      invocationId: 'inv_contract_0001',
      modelId: SEEDANCE_VIDEO_MODELS[2].id,
      prompt: '雨巷中人物缓步前行',
      resolution: { height: 1280, width: 720 },
    },
  };
};

const ADAPTER_METHOD_SURFACE: ReadonlySet<string> = new Set([
  'validateCredential',
  'submit',
  'poll',
  'download',
  'normalizeError',
  'evidenceOf',
]);

const CODE_PATTERN = /^MODEL_[A-Z_]+$/u;

describe('VideoModelPort 通用契约（Seedance/Mock/Agnes；low-cost 5.4）', () => {
  const fixtures: readonly (readonly [string, () => Fixture])[] = [
    ['SEEDANCE', seedanceFixture],
    ['MOCK', () => fixtureOf('MOCK')],
    ['AGNES', () => fixtureOf('AGNES')],
  ];

  for (const [name, build] of fixtures) {
    it(`${name}—submit 恒 ASYNC、poll 状态联合一致、download 校验 MP4 魔数`, async () => {
      const { adapter, advanceToSucceeded, request } = build();
      const submission = await adapter.submit(request, new AbortController().signal);
      expect(submission).toMatchObject({ kind: 'ASYNC' });
      expect(submission.kind === 'ASYNC' ? submission.providerTaskId : '').not.toBe('');

      const pending = await adapter.poll(
        submission.kind === 'ASYNC' ? submission.providerTaskId : '',
        new AbortController().signal,
      );
      expect(pending).toEqual({ state: 'PENDING' });

      advanceToSucceeded();
      const succeeded = await adapter.poll(
        submission.kind === 'ASYNC' ? submission.providerTaskId : '',
        new AbortController().signal,
      );
      expect(succeeded.state).toBe('SUCCEEDED');
      if (succeeded.state !== 'SUCCEEDED') return;
      expect(typeof succeeded.result.url).toBe('string');
      // 视频域结果扩展（actualDurationSec）：未回报 null 如实，回报为有限数。
      const videoResult = succeeded.result as VideoResultRef;
      expect(
        videoResult.actualDurationSec === null || typeof videoResult.actualDurationSec === 'number',
      ).toBe(true);

      const download = await adapter.download(succeeded.result, new AbortController().signal);
      expect(download.mimeType).toBe('video/mp4');
      expect(isFtypMp4(download.bytes)).toBe(true);
    });

    it(`${name}—公开方法面恰为 Port 六方法，Provider DTO 不越过 Adapter 边界`, async () => {
      const { adapter } = build();
      const publicMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter)).filter(
        (key) => key !== 'constructor',
      );
      expect(publicMethods.sort()).toEqual([...ADAPTER_METHOD_SURFACE].sort());
      // 外来错误：normalizeError 归一稳定 code；evidenceOf 不暴露任何 Provider 结构。
      const foreign = new Error('contract foreign error');
      const normalized: NormalizedModelError = adapter.normalizeError(foreign);
      expect(normalized.code).toMatch(CODE_PATTERN);
      expect(typeof normalized.retryable).toBe('boolean');
      const evidence: ModelCallEvidence | null = adapter.evidenceOf(foreign);
      expect(evidence).toBeNull();
      // 凭据校验零网络（解密加载语义）且不回显明文。
      await expect(adapter.validateCredential()).resolves.toEqual({ ok: true });
    });
  }
});
