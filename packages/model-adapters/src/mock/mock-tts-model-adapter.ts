import type {
  CredentialCheck,
  ModelCallEvidence,
  NormalizedModelError,
  TtsModelPort,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from '@jingxu/application';

import { createMockModelError } from './mock-text-model-adapter';

/** synthesize 消费的声明式步骤；序列即部分失败矩阵（镜像 MockImageSubmitStep）。 */
export type MockTtsSynthesisStep =
  | Readonly<{ afterMs?: number; durationMs?: number; kind: 'SYNC' }>
  | Readonly<{ afterMs?: number; error: NormalizedModelError; kind: 'ERROR' }>
  | Readonly<{ afterMs: number; kind: 'TIMEOUT' }>;

export interface MockTtsModelAdapterOptions {
  readonly credentialCheck?: CredentialCheck;
  readonly steps: readonly MockTtsSynthesisStep[];
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class MockTtsModelError extends Error {
  public readonly normalized: NormalizedModelError;
  /** 确定性原始响应证据（main-only 留证通道）；无响应的本地失败为全 null。 */
  public readonly evidence: ModelCallEvidence;

  public constructor(
    normalized: NormalizedModelError,
    evidence: ModelCallEvidence = { bodyText: null, httpStatus: null, truncated: false },
  ) {
    super(normalized.detail ?? normalized.code);
    this.name = 'MockTtsModelError';
    this.normalized = normalized;
    this.evidence = evidence;
  }
}

const TEXT = new TextEncoder();

/** FNV-1a 32 位种子哈希：同 invocationId 跨进程跨重启稳定（与图片 Mock 同法）。 */
const seedHashOf = (seed: string): number => {
  let hash = 0x811c9dc5;
  for (const byte of TEXT.encode(seed)) {
    hash = (Math.imul(hash ^ byte, 0x01000193) & 0xffffffff) >>> 0;
  }
  return hash >>> 0;
};

/** Mock WAV 固定规格：16 kHz 单声道 16 位 PCM（ffprobe 可精确读出时长）。 */
export const MOCK_TTS_SAMPLE_RATE = 16_000;
export const MOCK_TTS_MIME_TYPE = 'audio/wav';
/** 默认时长公式：台词字符数 × 200ms（确定性，供对齐场景按文本长度推算）。 */
export const MOCK_TTS_MS_PER_CHAR = 200;

/**
 * 确定性 WAV：44 字节 RIFF 头 + 种子化 16 位样本。真实 PCM 结构（RIFF/WAVE/
 * fmt /data），可被 ffprobe 与内容寻址存储直接消费；字节完全由
 * (seed, durationMs) 决定——同 invocationId 同台词跨进程逐位一致，不同种子
 * 字节可区分。
 */
export const encodeMockWav = (seed: string, durationMs: number): Uint8Array => {
  const sampleCount = Math.max(1, Math.round((durationMs * MOCK_TTS_SAMPLE_RATE) / 1_000));
  const dataSize = sampleCount * 2;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  out.set(TEXT.encode('RIFF'), 0);
  view.setUint32(4, 36 + dataSize, true);
  out.set(TEXT.encode('WAVE'), 8);
  out.set(TEXT.encode('fmt '), 12);
  view.setUint32(16, 16, true); // fmt 块长度（PCM 固定 16）
  view.setUint16(20, 1, true); // 格式：PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, MOCK_TTS_SAMPLE_RATE, true);
  view.setUint32(28, MOCK_TTS_SAMPLE_RATE * 2, true); // 字节率 = 采样率 × 块对齐
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  out.set(TEXT.encode('data'), 36);
  view.setUint32(40, dataSize, true);
  const seedHash = seedHashOf(seed);
  for (let index = 0; index < sampleCount; index += 1) {
    // 低幅确定性波形：(种子 + 步进) 折入 ±128 区间，避免削波且同种子可复现。
    view.setInt16(44 + index * 2, (((seedHash + index * 13) & 0xff) - 128) * 64, true);
  }
  return out;
};

const defaultWait = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new MockTtsModelError(createMockModelError('MODEL_CANCELLED')));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new MockTtsModelError(createMockModelError('MODEL_CANCELLED')));
      },
      { once: true },
    );
  });
};

/** 确定性失败原文（同 invocationId+code 跨进程稳定）：限流记 429，其余 500。 */
const mockErrorEvidenceOf = (invocationId: string, code: string): ModelCallEvidence =>
  Object.freeze({
    bodyText: JSON.stringify({ error: { code, invocation: invocationId } }),
    httpStatus: code === 'MODEL_RATE_LIMITED' ? 429 : 500,
    truncated: false,
  });

/**
 * 只用于确定性测试的 TtsModelPort 实现。synthesize 消费声明式步骤序列，
 * 成功段本地重放确定性 WAV——不读取网络、凭据或用户目录。时长不随结果
 * 返回（Port 政策）：调用方须以 ffprobe 实测字节得到 durationMs。
 */
export class MockTtsModelAdapter implements TtsModelPort {
  readonly #credentialCheck: CredentialCheck;
  readonly #steps: readonly MockTtsSynthesisStep[];
  readonly #wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  #cursor = 0;

  public constructor(options: MockTtsModelAdapterOptions) {
    this.#credentialCheck = options.credentialCheck ?? Object.freeze({ ok: true });
    this.#steps = Object.freeze([...options.steps]);
    this.#wait = options.wait ?? defaultWait;
  }

  public validateCredential(): Promise<CredentialCheck> {
    return Promise.resolve(this.#credentialCheck);
  }

  public async synthesize(
    request: TtsSynthesisRequest,
    signal: AbortSignal,
  ): Promise<TtsSynthesisResult> {
    const step = this.#steps[this.#cursor];
    this.#cursor += 1;
    if (step === undefined) {
      throw new MockTtsModelError(createMockModelError('MODEL_UNKNOWN'));
    }
    if (signal.aborted) {
      throw new MockTtsModelError(createMockModelError('MODEL_CANCELLED'));
    }
    if ((step.afterMs ?? 0) > 0) {
      await this.#wait(step.afterMs ?? 0, signal);
    }
    if (step.kind === 'ERROR') {
      throw new MockTtsModelError(
        step.error,
        mockErrorEvidenceOf(request.invocationId, step.error.code),
      );
    }
    if (step.kind === 'TIMEOUT') {
      throw new MockTtsModelError(createMockModelError('MODEL_TIMEOUT'));
    }
    const durationMs =
      step.durationMs ?? Math.max(1, request.spokenText.length * MOCK_TTS_MS_PER_CHAR);
    return Object.freeze({
      audio: Object.freeze({
        bytes: encodeMockWav(request.invocationId, durationMs),
        mimeType: MOCK_TTS_MIME_TYPE,
      }),
      // 真实 Provider 响应形状未探测（2.2 待实测）→ 不伪造请求级 id，统一 null。
      httpStatus: 200,
      providerRequestId: null,
      usage: Object.freeze({ outputCharacters: request.spokenText.length, outputTokens: null }),
    });
  }

  public normalizeError(error: unknown): NormalizedModelError {
    if (error instanceof MockTtsModelError) return error.normalized;
    return Object.freeze({
      code: 'MODEL_UNKNOWN',
      detail: 'Mock tts model call failed.',
      providerRequestId: null,
      retryable: false,
      userAction: null,
    });
  }

  public evidenceOf(error: unknown): ModelCallEvidence | null {
    return error instanceof MockTtsModelError ? error.evidence : null;
  }
}
