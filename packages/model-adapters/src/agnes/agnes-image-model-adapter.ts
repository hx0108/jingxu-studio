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

import {
  AGNES_IMAGE_DOWNLOAD_DOMAIN_SUFFIXES,
  AGNES_IMAGE_GENERATIONS_URL,
  AGNES_IMAGE_INVOCATION_TIMEOUT_MS,
  deriveAgnesImageSize,
  isAgnesImageModelId,
} from './agnes-image-models';

interface AgnesImageResponse {
  readonly created?: unknown;
  readonly data?: readonly { readonly url?: unknown }[];
  /** 实测顶层 task_id（t2i/i2i 任务号）；留作调用证据引用。 */
  readonly task_id?: unknown;
}

class AgnesImageAdapterError extends Error {
  /**
   * 原始响应证据（main-only 留证通道）：本地校验失败未发请求时为全 null；
   * 不进入 normalized（Renderer 可达路径）与日志。
   */
  public constructor(
    public readonly normalized: NormalizedModelError,
    public readonly evidence: ModelCallEvidence = {
      bodyText: null,
      httpStatus: null,
      truncated: false,
    },
  ) {
    super(normalized.code);
    this.name = 'AgnesImageAdapterError';
  }
}

/** 响应体读取上限（防御性截断；url 模式实际响应远小于此）。 */
const RESPONSE_BODY_READ_CAP = 65_536;

const readBodyCapped = async (
  response: Response,
): Promise<{ bodyText: string; truncated: boolean }> => {
  const raw = await response.text();
  return raw.length > RESPONSE_BODY_READ_CAP
    ? { bodyText: raw.slice(0, RESPONSE_BODY_READ_CAP), truncated: true }
    : { bodyText: raw, truncated: false };
};

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

/** 注册域后缀匹配（CDN 桶随任务变化，单域清单不成立）。 */
const hasAllowedDownloadDomain = (hostname: string): boolean => {
  const lower = hostname.toLowerCase();
  return AGNES_IMAGE_DOWNLOAD_DOMAIN_SUFFIXES.some(
    (suffix) => lower === suffix || lower.endsWith(`.${suffix}`),
  );
};

export interface AgnesImageModelAdapterOptions {
  readonly credentialId: string;
  readonly credentialPort: CredentialPort;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
}

/**
 * Agnes AI 图片生成（`POST /v1/images/generations`，Bearer Agnes Key）。
 *
 * 官方 wiki + 2026-09-21 受控探针：该 API 为同步形态——POST 直接返回终态结果
 * URL、无任务轮询接口，因此 submit 恒返回 `SYNC` 终态引用；poll() 只会在误用
 * 或恢复异常时被调用，归一化为 MODEL_UNKNOWN 失败而非伪造成功引用（红线：
 * 不伪造 Provider 数据）。双模型（2.1/2.5 Flash）请求形状一致，按
 * `request.modelId`（候选行冻结值）分发，构造无需 modelId。
 * Key 经 CredentialPort 在基础设施边界读取，不进入日志、错误 detail 或返回值。
 */
export class AgnesImageModelAdapter implements ImageModelPort {
  readonly #credentialId: string;
  readonly #credentialPort: CredentialPort;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutSignal: (milliseconds: number) => AbortSignal;

  public constructor(options: AgnesImageModelAdapterOptions) {
    this.#credentialId = options.credentialId;
    this.#credentialPort = options.credentialPort;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutSignal =
      options.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  }

  /** V1：仅验证凭据可解密加载，不发起计费请求；真实连通性验证在门控 canary。 */
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
    if (!isAgnesImageModelId(request.modelId)) {
      // 与 Seedream 构造守卫同口径：配置错误是编程/迁移缺陷，非 Provider 语义。
      throw new Error('MODEL_CONFIGURATION_INVALID');
    }
    if (
      !Number.isInteger(request.size.height) ||
      !Number.isInteger(request.size.width) ||
      request.size.height <= 0 ||
      request.size.width <= 0
    ) {
      throw new AgnesImageAdapterError(
        normalized('MODEL_INPUT_TOO_LARGE', false, '按画幅映射调整尺寸后重试'),
      );
    }

    const apiKey = await this.#credentialPort.loadCredential(this.#credentialId);
    const image = request.referenceImages.map(
      (reference) => `data:${reference.mimeType};base64,${base64Of(reference.bytes)}`,
    );
    const { ratio, size } = deriveAgnesImageSize(request.size);
    try {
      const invocationSignal = AbortSignal.any([
        signal,
        this.#timeoutSignal(AGNES_IMAGE_INVOCATION_TIMEOUT_MS),
      ]);
      if (invocationSignal.aborted) throw invocationSignal.reason;
      const response = await this.#fetch(AGNES_IMAGE_GENERATIONS_URL, {
        body: JSON.stringify({
          extra_body: {
            ...(image.length > 0 ? { image } : {}),
            // 官方陷阱：response_format 必须嵌在 extra_body，顶层会被拒绝。
            response_format: 'url',
          },
          model: request.modelId,
          prompt: request.prompt,
          ratio,
          size,
        }),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        method: 'POST',
        redirect: 'error',
        signal: invocationSignal,
      });
      // 先读体再判错：非 2xx 的原始 body 是限流/风控复盘唯一证据。
      const { bodyText, truncated } = await readBodyCapped(response);
      const raw: ImageRawResponse = Object.freeze({ bodyText, httpStatus: response.status, truncated });
      if (!response.ok) {
        throw new AgnesImageAdapterError(this.#normalizeStatus(response.status), raw);
      }
      let payload: AgnesImageResponse;
      try {
        payload = JSON.parse(bodyText) as AgnesImageResponse;
      } catch {
        throw new AgnesImageAdapterError(
          normalized('MODEL_INVALID_RESPONSE', false, '重新生成或稍后重试'),
          raw,
        );
      }
      const item = payload.data?.[0];
      if (typeof item?.url !== 'string' || item.url.length === 0) {
        throw new AgnesImageAdapterError(
          normalized('MODEL_INVALID_RESPONSE', false, '重新生成或稍后重试'),
          raw,
        );
      }
      const result: ImageResultRef = Object.freeze({
        height: null,
        providerRequestId: typeof payload.task_id === 'string' ? payload.task_id : null,
        url: item.url,
        width: null,
      });
      return Object.freeze({
        kind: 'SYNC',
        raw,
        result,
        usage: { generatedImages: 1, outputTokens: null },
      });
    } catch (error) {
      throw this.#wrapTransportError(error, signal);
    }
  }

  public poll(): Promise<ImageTaskStatus> {
    return Promise.resolve({
      detail: 'Agnes 图片为同步语义：submit 已返回终态引用，不存在可轮询任务。',
      errorCode: 'MODEL_UNKNOWN',
      state: 'FAILED',
    });
  }

  public async download(resultRef: ImageResultRef, signal: AbortSignal): Promise<ImageDownload> {
    // 结果 URL 仅允许 https、无 userinfo 且落在 Agnes 注册域后缀内；其余一律
    // 拒绝（Port：不可得 → MODEL_RESULT_UNAVAILABLE）。
    let parsed: URL;
    try {
      parsed = new URL(resultRef.url);
    } catch {
      throw new AgnesImageAdapterError(normalized('MODEL_RESULT_UNAVAILABLE', false, '重新生成候选'));
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      !hasAllowedDownloadDomain(parsed.hostname)
    ) {
      throw new AgnesImageAdapterError(normalized('MODEL_RESULT_UNAVAILABLE', false, '重新生成候选'));
    }
    try {
      const response = await this.#fetch(parsed.toString(), {
        headers: {},
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.any([signal, this.#timeoutSignal(AGNES_IMAGE_INVOCATION_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        const { bodyText, truncated } = await readBodyCapped(response);
        throw new AgnesImageAdapterError(
          normalized('MODEL_RESULT_UNAVAILABLE', false, '重新生成候选'),
          { bodyText, httpStatus: response.status, truncated },
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const sniffed = sniffImageMime(bytes);
      if (sniffed === null) {
        throw new AgnesImageAdapterError(normalized('MODEL_INVALID_RESPONSE', false, '重新生成候选'));
      }
      return { bytes, mimeType: sniffed };
    } catch (error) {
      throw this.#wrapTransportError(error, signal, 'MODEL_RESULT_UNAVAILABLE', '重新生成候选');
    }
  }

  public normalizeError(error: unknown): NormalizedModelError {
    return error instanceof AgnesImageAdapterError
      ? error.normalized
      : normalized('MODEL_UNKNOWN', false, '检查 Provider 配置后重试');
  }

  public evidenceOf(error: unknown): ModelCallEvidence | null {
    return error instanceof AgnesImageAdapterError ? error.evidence : null;
  }

  #wrapTransportError(
    error: unknown,
    signal: AbortSignal,
    fallbackCode: NormalizedModelError['code'] = 'MODEL_NETWORK_ERROR',
    fallbackAction: string | null = '等待后重试',
  ): Error {
    if (error instanceof AgnesImageAdapterError) return error;
    if (error instanceof SyntaxError) {
      return new AgnesImageAdapterError(
        normalized('MODEL_INVALID_RESPONSE', false, '重新生成或稍后重试'),
      );
    }
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'TimeoutError') {
      return new AgnesImageAdapterError(normalized('MODEL_TIMEOUT', false, '人工重试任务'));
    }
    if (name === 'AbortError' || signal.aborted) {
      return new AgnesImageAdapterError(normalized('MODEL_CANCELLED', false, null));
    }
    return new AgnesImageAdapterError(normalized(fallbackCode, true, fallbackAction));
  }

  #normalizeStatus(status: number): NormalizedModelError {
    if (status === 401 || status === 403) {
      return normalized('MODEL_CREDENTIAL_INVALID', false, '重新配置 Agnes API Key');
    }
    if (status === 429) return normalized('MODEL_RATE_LIMITED', true, '等待后重试');
    if (status >= 500) return normalized('MODEL_PROVIDER_ERROR', true, '等待后重试');
    if (status === 404) return normalized('MODEL_MODEL_UNAVAILABLE', false, '检查模型配置后重试');
    if (status === 413) return normalized('MODEL_INPUT_TOO_LARGE', false, '检查请求参数后重试');
    return normalized('MODEL_CONTENT_REJECTED', false, '调整提示词或参考图后重试');
  }
}
