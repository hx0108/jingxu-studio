import type {
  CredentialCheck,
  ModelCallEvidence,
  ModelErrorCode,
  NormalizedModelError,
  VideoDownload,
  VideoGenerationRequest,
  VideoModelPort,
  VideoResultRef,
  VideoTaskStatus,
  VideoTaskSubmission,
} from '@jingxu/application';

import { createMockModelError } from './mock-text-model-adapter';

/**
 * submit 消费的声明式步骤；N 候选 = N 次 submit，序列即部分失败矩阵。
 * 视频域无 SYNC 形态（Seedance 真 ASYNC）——成功路径恒为 ASYNC + 轮询计划。
 */
export type MockVideoSubmitStep =
  | Readonly<{
      afterMs?: number;
      failureCode?: ModelErrorCode;
      kind: 'ASYNC';
      pendingPolls?: number;
    }>
  | Readonly<{ afterMs?: number; error: NormalizedModelError; kind: 'ERROR' }>
  | Readonly<{ afterMs: number; kind: 'TIMEOUT' }>;

export interface MockVideoModelAdapterOptions {
  readonly credentialCheck?: CredentialCheck;
  readonly steps: readonly MockVideoSubmitStep[];
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class MockVideoModelError extends Error {
  public readonly normalized: NormalizedModelError;
  /** 确定性原始响应证据（main-only 留证通道）；无响应的本地失败为全 null。 */
  public readonly evidence: ModelCallEvidence;

  public constructor(
    normalized: NormalizedModelError,
    evidence: ModelCallEvidence = { bodyText: null, httpStatus: null, truncated: false },
  ) {
    super(normalized.detail ?? normalized.code);
    this.name = 'MockVideoModelError';
    this.normalized = normalized;
    this.evidence = evidence;
  }
}

interface MockVideoPollPlan {
  readonly failureCode: ModelErrorCode | null;
  readonly height: number;
  remainingPending: number;
  readonly seed: string;
  readonly width: number;
}

const MOCK_URL_PATTERN = /^mock-video:\/\/([A-Za-z0-9_-]+)$/u;

/**
 * 规范短片（1s H.264 baseline 48x48 faststart，ffmpeg testsrc2 +bitexact 定量生成）：
 * 真实可解码 mp4（浏览器 `<video>` 与 ftyp 嗅探直接消费），字节全实例恒等。视频段
 * 无逐种子编码器——所有候选返回同一段片子，内容寻址层自然合流为同一 fileSha256，
 * 候选行仍按 seed（invocationId）区分。
 */
const MOCK_MP4_BASE64 =
  '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';

const decodeBase64 = (encoded: string): Uint8Array => {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/** 规范短片字节（全实例恒等、按约定只读——TypedArray 不可 Object.freeze；导出供离线断言复算 sha256）。 */
export const MOCK_VIDEO_MP4_BYTES: Uint8Array = decodeBase64(MOCK_MP4_BASE64);

const defaultWait = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new MockVideoModelError(createMockModelError('MODEL_CANCELLED')));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new MockVideoModelError(createMockModelError('MODEL_CANCELLED')));
      },
      { once: true },
    );
  });
};

/** 视频域 usage 恒量：无图片计数，输出 token 数为确定性占位（镜像 Seedance 映射形态）。 */
const MOCK_USAGE = Object.freeze({ generatedImages: null, outputTokens: 96_000 });

/** 确定性失败原文（同 invocationId+code 跨进程稳定）：限流记 429，其余 500。 */
const mockErrorEvidenceOf = (invocationId: string, code: ModelErrorCode): ModelCallEvidence =>
  Object.freeze({
    bodyText: JSON.stringify({ error: { code, invocation: invocationId } }),
    httpStatus: code === 'MODEL_RATE_LIMITED' ? 429 : 500,
    truncated: false,
  });

/**
 * 只用于确定性测试的 VideoModelPort 实现。submit 消费声明式步骤序列并恒以
 * ASYNC 形态登记轮询计划；download 从 mock-video:// URL 本地重放规范短片——
 * 不读取网络、凭据或用户目录。
 */
export class MockVideoModelAdapter implements VideoModelPort {
  readonly #credentialCheck: CredentialCheck;
  readonly #steps: readonly MockVideoSubmitStep[];
  readonly #wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #pollPlans = new Map<string, MockVideoPollPlan>();
  #cursor = 0;

  public constructor(options: MockVideoModelAdapterOptions) {
    this.#credentialCheck = options.credentialCheck ?? Object.freeze({ ok: true });
    this.#steps = Object.freeze([...options.steps]);
    this.#wait = options.wait ?? defaultWait;
  }

  public validateCredential(): Promise<CredentialCheck> {
    return Promise.resolve(this.#credentialCheck);
  }

  public async submit(
    request: VideoGenerationRequest,
    signal: AbortSignal,
  ): Promise<VideoTaskSubmission> {
    const sequence = this.#cursor + 1;
    const step = this.#steps[this.#cursor];
    this.#cursor = sequence;
    if (step === undefined) {
      // 预算外提交按 MODEL_UNKNOWN 候选级失败（失控循环熔断，与图片 Mock 同口径）。
      throw new MockVideoModelError(createMockModelError('MODEL_UNKNOWN'));
    }
    if (signal.aborted) {
      throw new MockVideoModelError(createMockModelError('MODEL_CANCELLED'));
    }
    if ((step.afterMs ?? 0) > 0) {
      await this.#wait(step.afterMs ?? 0, signal);
    }
    if (step.kind === 'ERROR') {
      throw new MockVideoModelError(
        step.error,
        mockErrorEvidenceOf(request.invocationId, step.error.code),
      );
    }
    if (step.kind === 'TIMEOUT') {
      throw new MockVideoModelError(createMockModelError('MODEL_TIMEOUT'));
    }
    // ASYNC（唯一成功形态）：登记轮询计划，providerTaskId 与图片 Mock 同序命名。
    const providerTaskId = `mock-video-task-${String(sequence)}`;
    this.#pollPlans.set(providerTaskId, {
      failureCode: step.failureCode ?? null,
      height: request.resolution.height,
      remainingPending: step.pendingPolls ?? 0,
      seed: request.invocationId,
      width: request.resolution.width,
    });
    return Object.freeze({ kind: 'ASYNC', providerTaskId });
  }

  public poll(providerTaskId: string, signal: AbortSignal): Promise<VideoTaskStatus> {
    if (signal.aborted) {
      return Promise.reject(new MockVideoModelError(createMockModelError('MODEL_CANCELLED')));
    }
    const plan = this.#pollPlans.get(providerTaskId);
    if (plan === undefined) {
      return Promise.resolve({
        detail: 'Mock video task not found.',
        errorCode: 'MODEL_UNKNOWN',
        state: 'FAILED',
      });
    }
    if (plan.remainingPending > 0) {
      plan.remainingPending -= 1;
      return Promise.resolve({ state: 'PENDING' });
    }
    if (plan.failureCode !== null) {
      return Promise.resolve({
        detail: `Mock poll outcome: ${plan.failureCode}.`,
        errorCode: plan.failureCode,
        state: 'FAILED',
      });
    }
    const result: VideoResultRef = Object.freeze({
      // 规范短片实测 1s：Mock 如实回报自身片长，与请求档位（5/10s）解耦。
      actualDurationSec: 1,
      height: plan.height,
      providerRequestId: providerTaskId,
      url: `mock-video://${plan.seed}`,
      width: plan.width,
    });
    return Promise.resolve({ result, state: 'SUCCEEDED', usage: MOCK_USAGE });
  }

  public download(resultRef: VideoResultRef, signal: AbortSignal): Promise<VideoDownload> {
    if (signal.aborted) {
      return Promise.reject(new MockVideoModelError(createMockModelError('MODEL_CANCELLED')));
    }
    if (MOCK_URL_PATTERN.exec(resultRef.url) === null) {
      return Promise.reject(
        new MockVideoModelError(createMockModelError('MODEL_RESULT_UNAVAILABLE')),
      );
    }
    return Promise.resolve({ bytes: MOCK_VIDEO_MP4_BYTES, mimeType: 'video/mp4' });
  }

  public normalizeError(error: unknown): NormalizedModelError {
    if (error instanceof MockVideoModelError) return error.normalized;
    return Object.freeze({
      code: 'MODEL_UNKNOWN',
      detail: 'Mock video model call failed.',
      providerRequestId: null,
      retryable: false,
      userAction: null,
    });
  }

  public evidenceOf(error: unknown): ModelCallEvidence | null {
    return error instanceof MockVideoModelError ? error.evidence : null;
  }
}
