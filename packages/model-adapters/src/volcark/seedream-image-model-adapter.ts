import type {
  CredentialCheck,
  CredentialPort,
  ImageDownload,
  ImageGenerationRequest,
  ImageModelPort,
  ImageRawResponse,
  ImageResultRef,
  ImageTaskStatus,
  ImageTaskSubmission,
  ModelCallEvidence,
  NormalizedModelError,
} from '@jingxu/application';

/** 0.2 官方核对锁定（docs/82379/1541523 + 1330310，快照 volcark-seedream-image/v1）。 */
export const SEEDREAM_MODEL_ID = 'doubao-seedream-5-0-lite-260128';
export const SEEDREAM_MODEL_IDS: readonly string[] = [
  SEEDREAM_MODEL_ID,
  'doubao-seedream-5-0-260128',
  'doubao-seedream-4-5-251128',
  'doubao-seedream-4-0-250828',
];
export const SEEDREAM_INVOCATION_TIMEOUT_MS = 120_000;
/** size：总像素与宽高比区间（快照 request.size）。 */
export const SEEDREAM_SIZE_TOTAL_PIXELS_RANGE: readonly [number, number] = [3_686_400, 16_777_216];
export const SEEDREAM_SIZE_ASPECT_RATIO_RANGE: readonly [number, number] = [0.0625, 16];
/** 参考图 image[]：张数、单张字节上限与允许格式（快照 request.image_param）。 */
export const SEEDREAM_IMAGE_MAX_COUNT = 14;
export const SEEDREAM_IMAGE_MAX_BYTES_EACH = 31_457_280;
const SEEDREAM_IMAGE_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/gif',
  'image/heic',
  'image/heif',
];

export const deriveSeedreamBaseUrl = (): string => 'https://ark.cn-beijing.volces.com';

interface SeedreamResponse {
  readonly data?: readonly {
    readonly error?: { readonly code?: unknown };
    /** 官方响应为 "WxH" 字符串（7.1 联调实录）；兼容对象形态。 */
    readonly size?: { readonly height?: unknown; readonly width?: unknown } | string;
    readonly url?: unknown;
  }[];
  readonly id?: unknown;
  readonly usage?: { readonly generated_images?: unknown; readonly output_tokens?: unknown };
}

class SeedreamAdapterError extends Error {
  /**
   * 原始响应证据（main-only 留证通道，design D5）：本地校验失败未发请求时为
   * 全 null；不进入 normalized（Renderer 可达路径）与日志。
   */
  public constructor(
    public readonly normalized: NormalizedModelError,
    public readonly evidence: ModelCallEvidence = { bodyText: null, httpStatus: null, truncated: false },
  ) {
    super(normalized.code);
    this.name = 'SeedreamAdapterError';
  }
}

/** 响应体读取上限（design D3 防御性截断；实际响应远小于此）。 */
const RESPONSE_BODY_READ_CAP = 65_536;

/** 读体（留证 + 解析共用）：超限截断并如实标记。 */
const readBodyCapped = async (
  response: Response,
): Promise<{ bodyText: string; truncated: boolean }> => {
  const raw = await response.text();
  return raw.length > RESPONSE_BODY_READ_CAP
    ? { bodyText: raw.slice(0, RESPONSE_BODY_READ_CAP), truncated: true }
    : { bodyText: raw, truncated: false };
};

export interface SeedreamImageModelAdapterOptions {
  readonly baseUrl?: string;
  readonly credentialId: string;
  readonly credentialPort: CredentialPort;
  readonly fetch?: typeof globalThis.fetch;
  readonly modelId?: string;
  readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
}

const normalized = (
  code: NormalizedModelError['code'],
  retryable: boolean,
  userAction: string | null,
): NormalizedModelError => ({ code, detail: null, providerRequestId: null, retryable, userAction });

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const base64Char = (index: number): string => BASE64_ALPHABET[index] ?? 'A';

const base64Of = (bytes: Uint8Array): string => {
  let out = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const b0 = bytes[offset] ?? 0;
    const b1 = bytes[offset + 1];
    const b2 = bytes[offset + 2];
    out += base64Char(b0 >>> 2);
    out += base64Char(((b0 & 0x03) << 4) | ((b1 ?? 0) >>> 4));
    out += b1 === undefined ? '=' : base64Char((((b1 & 0x0f) << 2) | ((b2 ?? 0) >>> 6)) & 0x3f);
    out += b2 === undefined ? '=' : base64Char(b2 & 0x3f);
  }
  return out;
};

/** 官方 "WxH" 字符串 → 宽高；对象形态兼容；不可解析为 null（Port 允许未知）。 */
const parseSeedreamSize = (
  size: { readonly height?: unknown; readonly width?: unknown } | string | undefined,
): Readonly<{ height: number | null; width: number | null }> => {
  if (typeof size === 'string') {
    const match = /^([1-9][0-9]{0,4})x([1-9][0-9]{0,4})$/u.exec(size);
    if (match === null) return { height: null, width: null };
    return {
      height: Number.parseInt(match[2] ?? '0', 10),
      width: Number.parseInt(match[1] ?? '0', 10),
    };
  }
  return {
    height: typeof size?.height === 'number' ? size.height : null,
    width: typeof size?.width === 'number' ? size.width : null,
  };
};

/** 结果字节嗅探（下载段不信任 Content-Type 时的兜底）。 */
const sniffImageMime = (bytes: Uint8Array): string | null => {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
};

/**
 * 火山方舟豆包 Seedream 图片生成（ARK `POST /api/v3/images/generations`，Bearer ARK Key）。
 *
 * 0.2 官方核对结论：该 API 为同步形态——POST 直接返回终态、无任务轮询接口，
 * 因此 submit 恒返回 `SYNC` 终态引用；poll() 只会在误用或恢复异常时被调用，
 * 归一化为 MODEL_UNKNOWN 失败而非伪造成功引用（红线：不伪造 Provider 数据）。
 * Key 经 CredentialPort（safeStorage credential_ref）在基础设施边界读取，
 * 不进入日志、错误 detail 或任何返回值。
 */
export class SeedreamImageModelAdapter implements ImageModelPort {
  readonly #baseUrl: string;
  readonly #credentialId: string;
  readonly #credentialPort: CredentialPort;
  readonly #fetch: typeof globalThis.fetch;
  readonly #modelId: string;
  readonly #timeoutSignal: (milliseconds: number) => AbortSignal;

  public constructor(options: SeedreamImageModelAdapterOptions) {
    const modelId = options.modelId ?? SEEDREAM_MODEL_ID;
    if (!SEEDREAM_MODEL_IDS.includes(modelId)) {
      throw new Error('MODEL_CONFIGURATION_INVALID');
    }
    this.#baseUrl = options.baseUrl ?? deriveSeedreamBaseUrl();
    this.#credentialId = options.credentialId;
    this.#credentialPort = options.credentialPort;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#modelId = modelId;
    this.#timeoutSignal =
      options.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  }

  /** V1：仅验证凭据可解密加载，不发起计费请求；真实连通性验证在 7.1 门控联调。 */
  public async validateCredential(): Promise<CredentialCheck> {
    try {
      await this.#credentialPort.loadCredential(this.#credentialId);
      return { ok: true };
    } catch {
      return { detail: null, errorCode: 'MODEL_CREDENTIAL_INVALID', ok: false };
    }
  }

  public async submit(
    request: ImageGenerationRequest,
    signal: AbortSignal,
  ): Promise<ImageTaskSubmission> {
    this.#assertSizeLegal(request);
    this.#assertReferenceImagesLegal(request);

    const apiKey = await this.#credentialPort.loadCredential(this.#credentialId);
    const image = request.referenceImages.map(
      (reference) => `data:${reference.mimeType};base64,${base64Of(reference.bytes)}`,
    );
    try {
      const invocationSignal = AbortSignal.any([
        signal,
        this.#timeoutSignal(SEEDREAM_INVOCATION_TIMEOUT_MS),
      ]);
      if (invocationSignal.aborted) throw invocationSignal.reason;
      const response = await this.#fetch(`${this.#baseUrl}/api/v3/images/generations`, {
        body: JSON.stringify({
          model: this.#modelId,
          prompt: request.prompt,
          response_format: 'url',
          size: `${String(request.size.width)}x${String(request.size.height)}`,
          watermark: true,
          ...(image.length > 0 ? { image } : {}),
        }),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        method: 'POST',
        redirect: 'error',
        signal: invocationSignal,
      });
      // 先读体再判错：非 2xx 的原始 body 是限流/风控复盘唯一证据（design D5）。
      const { bodyText, truncated } = await readBodyCapped(response);
      const raw: ImageRawResponse = Object.freeze({ bodyText, httpStatus: response.status, truncated });
      if (!response.ok) {
        throw new SeedreamAdapterError(this.#normalizeStatus(response.status), raw);
      }
      let payload: SeedreamResponse;
      try {
        payload = JSON.parse(bodyText) as SeedreamResponse;
      } catch {
        throw new SeedreamAdapterError(
          normalized('MODEL_INVALID_RESPONSE', false, '重新生成或稍后重试'),
          raw,
        );
      }
      const item = payload.data?.[0];
      if (item?.error !== undefined) {
        // 逐项失败（快照 response.partial_failure）：只传播稳定错误码，不透传 message。
        const providerCode = typeof item.error.code === 'string' ? item.error.code : '';
        throw new SeedreamAdapterError(
          providerCode.includes('content') || providerCode.includes('sensitive')
            ? normalized('MODEL_CONTENT_REJECTED', false, '调整提示词或参考图后重新生成')
            : normalized('MODEL_PROVIDER_ERROR', true, '等待后重试'),
          raw,
        );
      }
      if (typeof item?.url !== 'string' || item.url.length === 0) {
        throw new SeedreamAdapterError(
          normalized('MODEL_INVALID_RESPONSE', false, '重新生成或稍后重试'),
          raw,
        );
      }
      const reportedSize = parseSeedreamSize(item.size);
      const result: ImageResultRef = Object.freeze({
        height: reportedSize.height,
        providerRequestId: typeof payload.id === 'string' ? payload.id : null,
        url: item.url,
        width: reportedSize.width,
      });
      return Object.freeze({
        kind: 'SYNC',
        raw,
        result,
        usage: {
          generatedImages:
            typeof payload.usage?.generated_images === 'number'
              ? payload.usage.generated_images
              : null,
          outputTokens:
            typeof payload.usage?.output_tokens === 'number' ? payload.usage.output_tokens : null,
        },
      });
    } catch (error) {
      throw this.#wrapTransportError(error, signal);
    }
  }

  public poll(): Promise<ImageTaskStatus> {
    return Promise.resolve({
      detail: 'Seedream 为同步语义：submit 已返回终态引用，不存在可轮询任务。',
      errorCode: 'MODEL_UNKNOWN',
      state: 'FAILED',
    });
  }

  public async download(resultRef: ImageResultRef, signal: AbortSignal): Promise<ImageDownload> {
    // 结果 URL 仅允许 https 且不带 userinfo；其余一律拒绝（Port：不可得 → MODEL_RESULT_UNAVAILABLE）。
    let parsed: URL;
    try {
      parsed = new URL(resultRef.url);
    } catch {
      throw new SeedreamAdapterError(normalized('MODEL_RESULT_UNAVAILABLE', false, '重新生成候选'));
    }
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
      throw new SeedreamAdapterError(normalized('MODEL_RESULT_UNAVAILABLE', false, '重新生成候选'));
    }
    try {
      const response = await this.#fetch(parsed.toString(), {
        headers: {},
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.any([signal, this.#timeoutSignal(SEEDREAM_INVOCATION_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        // 下载段失败原文同样留证（design D5）；成功段字节走 CAS，不入证据。
        const { bodyText, truncated } = await readBodyCapped(response);
        throw new SeedreamAdapterError(
          normalized('MODEL_RESULT_UNAVAILABLE', false, '重新生成候选'),
          { bodyText, httpStatus: response.status, truncated },
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const sniffed = sniffImageMime(bytes);
      if (sniffed === null) {
        throw new SeedreamAdapterError(normalized('MODEL_INVALID_RESPONSE', false, '重新生成候选'));
      }
      return { bytes, mimeType: sniffed };
    } catch (error) {
      throw this.#wrapTransportError(error, signal, 'MODEL_RESULT_UNAVAILABLE', '重新生成候选');
    }
  }

  public normalizeError(error: unknown): NormalizedModelError {
    return error instanceof SeedreamAdapterError
      ? error.normalized
      : normalized('MODEL_UNKNOWN', false, '检查 Provider 配置后重试');
  }

  public evidenceOf(error: unknown): ModelCallEvidence | null {
    return error instanceof SeedreamAdapterError ? error.evidence : null;
  }

  #assertSizeLegal(request: ImageGenerationRequest): void {
    const { height, width } = request.size;
    if (
      !Number.isInteger(height) ||
      !Number.isInteger(width) ||
      height <= 0 ||
      width <= 0 ||
      width * height < SEEDREAM_SIZE_TOTAL_PIXELS_RANGE[0] ||
      width * height > SEEDREAM_SIZE_TOTAL_PIXELS_RANGE[1]
    ) {
      throw new SeedreamAdapterError(
        normalized('MODEL_INPUT_TOO_LARGE', false, '按画幅映射调整尺寸后重试'),
      );
    }
    const aspect = width / height;
    if (
      aspect < SEEDREAM_SIZE_ASPECT_RATIO_RANGE[0] ||
      aspect > SEEDREAM_SIZE_ASPECT_RATIO_RANGE[1]
    ) {
      throw new SeedreamAdapterError(
        normalized('MODEL_INPUT_TOO_LARGE', false, '按画幅映射调整尺寸后重试'),
      );
    }
  }

  #assertReferenceImagesLegal(request: ImageGenerationRequest): void {
    if (request.referenceImages.length > SEEDREAM_IMAGE_MAX_COUNT) {
      throw new SeedreamAdapterError(
        normalized('MODEL_INPUT_TOO_LARGE', false, '减少参考图数量后重试'),
      );
    }
    for (const reference of request.referenceImages) {
      if (
        reference.bytes.byteLength > SEEDREAM_IMAGE_MAX_BYTES_EACH ||
        !SEEDREAM_IMAGE_MIME_TYPES.includes(reference.mimeType)
      ) {
        throw new SeedreamAdapterError(
          normalized('MODEL_INPUT_TOO_LARGE', false, '调整参考图格式或大小后重试'),
        );
      }
    }
  }

  #wrapTransportError(
    error: unknown,
    signal: AbortSignal,
    fallbackCode: NormalizedModelError['code'] = 'MODEL_NETWORK_ERROR',
    fallbackAction: string | null = '等待后重试',
  ): Error {
    if (error instanceof SeedreamAdapterError) return error;
    if (error instanceof SyntaxError) {
      return new SeedreamAdapterError(
        normalized('MODEL_INVALID_RESPONSE', false, '重新生成或稍后重试'),
      );
    }
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'TimeoutError') {
      return new SeedreamAdapterError(normalized('MODEL_TIMEOUT', false, '人工重试任务'));
    }
    if (name === 'AbortError' || signal.aborted) {
      return new SeedreamAdapterError(normalized('MODEL_CANCELLED', false, null));
    }
    return new SeedreamAdapterError(normalized(fallbackCode, true, fallbackAction));
  }

  #normalizeStatus(status: number): NormalizedModelError {
    if (status === 401 || status === 403) {
      return normalized('MODEL_CREDENTIAL_INVALID', false, '重新配置 ARK API Key');
    }
    if (status === 429) return normalized('MODEL_RATE_LIMITED', true, '等待后重试');
    if (status >= 500) return normalized('MODEL_PROVIDER_ERROR', true, '等待后重试');
    if (status === 413 || status === 404) {
      return normalized('MODEL_INPUT_TOO_LARGE', false, '检查请求参数后重试');
    }
    return normalized('MODEL_CONTENT_REJECTED', false, '调整提示词或参考图后重试');
  }
}
