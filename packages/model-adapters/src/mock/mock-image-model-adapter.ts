import type {
  CredentialCheck,
  ImageDownload,
  ImageGenerationRequest,
  ImageModelPort,
  ImageResultRef,
  ImageTaskStatus,
  ImageTaskSubmission,
  ModelErrorCode,
  NormalizedModelError,
} from '@jingxu/application';

import { createMockModelError } from './mock-text-model-adapter';

/** submit 消费的声明式步骤；N 候选 = N 次 submit，序列即部分失败矩阵。 */
export type MockImageSubmitStep =
  | Readonly<{ afterMs?: number; kind: 'SYNC' }>
  | Readonly<{
      afterMs?: number;
      failureCode?: ModelErrorCode;
      kind: 'ASYNC';
      pendingPolls?: number;
    }>
  | Readonly<{ afterMs?: number; error: NormalizedModelError; kind: 'ERROR' }>
  | Readonly<{ afterMs: number; kind: 'TIMEOUT' }>;

export interface MockImageModelAdapterOptions {
  readonly credentialCheck?: CredentialCheck;
  readonly now?: () => number;
  readonly requestId?: (sequence: number, now: number) => string;
  readonly steps: readonly MockImageSubmitStep[];
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class MockImageModelError extends Error {
  public readonly normalized: NormalizedModelError;

  public constructor(normalized: NormalizedModelError) {
    super(normalized.detail ?? normalized.code);
    this.name = 'MockImageModelError';
    this.normalized = normalized;
  }
}

interface MockPollPlan {
  readonly failureCode: ModelErrorCode | null;
  readonly height: number;
  remainingPending: number;
  readonly seed: string;
  readonly width: number;
}

const TEXT = new TextEncoder();
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MOCK_URL_PATTERN = /^mock-image:\/\/(\d+)x(\d+)\/([A-Za-z0-9_-]+)$/u;

let crcTable: Uint32Array | undefined;

const crc32 = (bytes: Uint8Array): number => {
  crcTable ??= (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[n] = value;
    }
    return table;
  })();
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(TEXT.encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** FNV-1a 32 位种子哈希：同 invocationId 跨进程跨重启稳定。 */
const seedHashOf = (seed: string): number => {
  let hash = 0x811c9dc5;
  for (const byte of TEXT.encode(seed)) {
    hash = (Math.imul(hash ^ byte, 0x01000193) & 0xffffffff) >>> 0;
  }
  return hash >>> 0;
};

const adler32 = (bytes: Uint8Array): number => {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
};

/**
 * 手写 zlib 流（stored 块，不压缩）：本包约定不引 node: 模块，且 stored 块
 * 结构（BFINAL/BTYPE=00 + LEN/NLEN + adler32）对同输入完全确定。
 */
const zlibStored = (raw: Uint8Array): Uint8Array => {
  const blockCount = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + blockCount * 5 + raw.length + 4);
  const view = new DataView(out.buffer);
  out[0] = 0x78;
  out[1] = 0x01;
  let offset = 2;
  let position = 0;
  for (let block = 0; block < blockCount; block += 1) {
    const length = Math.min(raw.length - position, 65535);
    out[offset] = block === blockCount - 1 ? 1 : 0; // BFINAL + BTYPE=00
    out[offset + 1] = length & 0xff;
    out[offset + 2] = length >>> 8;
    const nlen = ~length & 0xffff;
    out[offset + 3] = nlen & 0xff;
    out[offset + 4] = nlen >>> 8;
    offset += 5;
    out.set(raw.subarray(position, position + length), offset);
    offset += length;
    position += length;
  }
  view.setUint32(offset, adler32(raw));
  return out;
};

/**
 * 确定性 8 位灰度 PNG：像素 = (seedHash + 7x + 13y) & 0xff，IDAT 为手写
 * stored zlib 流。真实 PNG 结构（签名/IHDR/IDAT/IEND + CRC32），可被浏览器
 * <img> 与内容寻址存储的哈希校验直接消费；字节完全由 (seed, width, height) 决定。
 */
export const encodeMockPng = (seed: string, width: number, height: number): Uint8Array => {
  const seedHash = seedHashOf(seed);
  const raw = new Uint8Array(height * (width + 1));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // 每行 filter: None
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      raw[offset] = (seedHash + x * 7 + y * 13) & 0xff;
      offset += 1;
    }
  }
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none
  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
};

const defaultWait = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new MockImageModelError(createMockModelError('MODEL_CANCELLED')));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new MockImageModelError(createMockModelError('MODEL_CANCELLED')));
      },
      { once: true },
    );
  });
};

const MOCK_USAGE = Object.freeze({ generatedImages: 1, outputTokens: null });

/**
 * 只用于确定性测试的 ImageModelPort 实现。submit 消费声明式步骤序列，
 * download 从 mock-image:// URL 本地重放确定性 PNG——不读取网络、凭据或用户目录。
 */
export class MockImageModelAdapter implements ImageModelPort {
  readonly #credentialCheck: CredentialCheck;
  readonly #now: () => number;
  readonly #requestId: (sequence: number, now: number) => string;
  readonly #steps: readonly MockImageSubmitStep[];
  readonly #wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #pollPlans = new Map<string, MockPollPlan>();
  #cursor = 0;

  public constructor(options: MockImageModelAdapterOptions) {
    this.#credentialCheck = options.credentialCheck ?? Object.freeze({ ok: true });
    this.#now = options.now ?? Date.now;
    this.#requestId =
      options.requestId ??
      ((sequence, now) => `mock-image-request-${String(now)}-${String(sequence)}`);
    this.#steps = Object.freeze([...options.steps]);
    this.#wait = options.wait ?? defaultWait;
  }

  public validateCredential(): Promise<CredentialCheck> {
    return Promise.resolve(this.#credentialCheck);
  }

  public async submit(
    request: ImageGenerationRequest,
    signal: AbortSignal,
  ): Promise<ImageTaskSubmission> {
    const sequence = this.#cursor + 1;
    const step = this.#steps[this.#cursor];
    this.#cursor = sequence;
    if (step === undefined) {
      throw new MockImageModelError(createMockModelError('MODEL_UNKNOWN'));
    }
    if (signal.aborted) {
      throw new MockImageModelError(createMockModelError('MODEL_CANCELLED'));
    }
    if ((step.afterMs ?? 0) > 0) {
      await this.#wait(step.afterMs ?? 0, signal);
    }
    if (step.kind === 'ERROR') {
      throw new MockImageModelError(step.error);
    }
    if (step.kind === 'TIMEOUT') {
      throw new MockImageModelError(createMockModelError('MODEL_TIMEOUT'));
    }
    const providerRequestId = this.#requestId(sequence, this.#now());
    const url = `mock-image://${String(request.size.width)}x${String(request.size.height)}/${request.invocationId}`;
    if (step.kind === 'ASYNC') {
      const providerTaskId = `mock-image-task-${String(sequence)}`;
      this.#pollPlans.set(providerTaskId, {
        failureCode: step.failureCode ?? null,
        height: request.size.height,
        remainingPending: step.pendingPolls ?? 0,
        seed: request.invocationId,
        width: request.size.width,
      });
      return Object.freeze({ kind: 'ASYNC', providerTaskId });
    }
    return Object.freeze({
      kind: 'SYNC',
      result: this.#resultRef(request, url, providerRequestId),
      usage: MOCK_USAGE,
    });
  }

  public poll(providerTaskId: string, signal: AbortSignal): Promise<ImageTaskStatus> {
    if (signal.aborted) {
      return Promise.reject(new MockImageModelError(createMockModelError('MODEL_CANCELLED')));
    }
    const plan = this.#pollPlans.get(providerTaskId);
    if (plan === undefined) {
      return Promise.resolve({
        detail: 'Mock image task not found.',
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
    return Promise.resolve({
      result: this.#resultRef(
        {
          invocationId: plan.seed,
          modelId: 'mock-image-model',
          prompt: '',
          referenceImages: [],
          size: { height: plan.height, width: plan.width },
        },
        `mock-image://${String(plan.width)}x${String(plan.height)}/${plan.seed}`,
        null,
      ),
      state: 'SUCCEEDED',
      usage: MOCK_USAGE,
    });
  }

  public download(resultRef: ImageResultRef, signal: AbortSignal): Promise<ImageDownload> {
    if (signal.aborted) {
      return Promise.reject(new MockImageModelError(createMockModelError('MODEL_CANCELLED')));
    }
    const match = MOCK_URL_PATTERN.exec(resultRef.url);
    if (match === null) {
      return Promise.reject(
        new MockImageModelError(createMockModelError('MODEL_RESULT_UNAVAILABLE')),
      );
    }
    return Promise.resolve({
      bytes: encodeMockPng(match[3] ?? '', Number(match[1]), Number(match[2])),
      mimeType: 'image/png',
    });
  }

  public normalizeError(error: unknown): NormalizedModelError {
    if (error instanceof MockImageModelError) return error.normalized;
    return Object.freeze({
      code: 'MODEL_UNKNOWN',
      detail: 'Mock image model call failed.',
      providerRequestId: null,
      retryable: false,
      userAction: null,
    });
  }

  #resultRef(
    request: ImageGenerationRequest,
    url: string,
    providerRequestId: string | null,
  ): ImageResultRef {
    return Object.freeze({
      height: request.size.height,
      providerRequestId,
      url,
      width: request.size.width,
    });
  }
}
