import type {
  CredentialCheck,
  CredentialPort,
  ModelCallEvidence,
  NormalizedModelError,
  VideoDownload,
  VideoGenerationRequest,
  VideoModelPort,
  VideoRawResponse,
  VideoResultRef,
  VideoTaskStatus,
  VideoTaskSubmission,
} from '@jingxu/application';

/**
 * 火山方舟豆包 Seedance 视频生成（首帧图生视频 i2v，真 ASYNC）。
 *
 * API 形态（Ark v3 内容生成任务）：submit = `POST /api/v3/contents/generations/tasks`
 * 返回 {id}；poll = `GET /api/v3/contents/generations/tasks/{id}` 按 status 推进；
 * download = 结果 video_url https 直下并魔数嗅探 mp4（ftyp box）。字段名与档位
 * 以 7.1 官方核验/实测为准锁定（快照 volcark-seedance-video/v1）——当前按方舟
 * 公开文档形态实现，真实联调探针负责实证与勘误。Key 经 CredentialPort 在基础
 * 设施边界读取，不进入日志、错误 detail 或任何返回值。
 */

/** 7.1 官方核验锁定（当前为文档候选，未经真实联调实证）。 */
export const SEEDANCE_MODEL_ID = 'doubao-seedance-1-0-lite-i2v-250428';
export const SEEDANCE_MODEL_IDS: readonly string[] = [SEEDANCE_MODEL_ID];
/** 单段调用（create/poll/下载）超时上限；整任务轮询截止由调度器 pollDeadlineMs 控制。 */
export const SEEDANCE_VIDEO_SEGMENT_TIMEOUT_MS = 120_000;
/** 时长档位（快照 constraints；就近映射在服务层，本层只做区间守卫）。 */
export const SEEDANCE_DURATION_RANGE: readonly [number, number] = [5, 10];
/** 分辨率上限（1080p 档；快照 constraints）。 */
export const SEEDANCE_RESOLUTION_MAX_EDGE = 1920;
/** 首帧字节上限与允许格式（快照 request.image_param 同源口径）。 */
export const SEEDANCE_FIRST_FRAME_MAX_BYTES = 10 * 1024 * 1024;
const SEEDANCE_FIRST_FRAME_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

export const deriveSeedanceBaseUrl = (): string => 'https://ark.cn-beijing.volces.com';

interface SeedanceTaskResponse {
  readonly content?: { readonly video_url?: unknown };
  readonly error?: { readonly code?: unknown };
  readonly id?: unknown;
  readonly status?: unknown;
  readonly usage?: {
    readonly completion_tokens?: unknown;
    readonly generated_video_second?: unknown;
    readonly generated_video_seconds?: unknown;
  };
}

class SeedanceAdapterError extends Error {
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
    this.name = 'SeedanceAdapterError';
  }
}

/** 响应体读取上限（防御性截断；与 Seedream 同口径）。 */
const RESPONSE_BODY_READ_CAP = 65_536;

const readBodyCapped = async (
  response: Response,
): Promise<{ bodyText: string; truncated: boolean }> => {
  const raw = await response.text();
  return raw.length > RESPONSE_BODY_READ_CAP
    ? { bodyText: raw.slice(0, RESPONSE_BODY_READ_CAP), truncated: true }
    : { bodyText: raw, truncated: false };
};

export interface SeedanceVideoModelAdapterOptions {
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

/** mp4 魔数嗅探：第 4-7 字节为 ASCII "ftyp"（ISO BMFF box 头）；不信任 Content-Type。 */
const isMp4 = (bytes: Uint8Array): boolean =>
  bytes.length >= 12 &&
  bytes[4] === 0x66 &&
  bytes[5] === 0x74 &&
  bytes[6] === 0x79 &&
  bytes[7] === 0x70;

/** Provider 回报的实际时长（秒）；候选字段名兼容，未回报为 null 如实（不估算）。 */
const actualDurationOf = (usage: SeedanceTaskResponse['usage']): number | null => {
  for (const value of [usage?.generated_video_seconds, usage?.generated_video_second]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return null;
};

export class SeedanceVideoModelAdapter implements VideoModelPort {
  readonly #baseUrl: string;
  readonly #credentialId: string;
  readonly #credentialPort: CredentialPort;
  readonly #fetch: typeof globalThis.fetch;
  readonly #modelId: string;
  readonly #timeoutSignal: (milliseconds: number) => AbortSignal;

  public constructor(options: SeedanceVideoModelAdapterOptions) {
    const modelId = options.modelId ?? SEEDANCE_MODEL_ID;
    if (!SEEDANCE_MODEL_IDS.includes(modelId)) {
      throw new Error('MODEL_CONFIGURATION_INVALID');
    }
    this.#baseUrl = options.baseUrl ?? deriveSeedanceBaseUrl();
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
    request: VideoGenerationRequest,
    signal: AbortSignal,
  ): Promise<VideoTaskSubmission> {
    this.#assertRequestLegal(request);

    const apiKey = await this.#credentialPort.loadCredential(this.#credentialId);
    try {
      const invocationSignal = AbortSignal.any([
        signal,
        this.#timeoutSignal(SEEDANCE_VIDEO_SEGMENT_TIMEOUT_MS),
      ]);
      if (invocationSignal.aborted) throw invocationSignal.reason;
      const response = await this.#fetch(`${this.#baseUrl}/api/v3/contents/generations/tasks`, {
        body: JSON.stringify({
          content: [
            { text: request.prompt, type: 'text' },
            {
              image_url: {
                url: `data:${request.firstFrame.mimeType};base64,${base64Of(request.firstFrame.bytes)}`,
              },
              type: 'image_url',
            },
          ],
          duration: request.durationSec,
          model: this.#modelId,
          // i2v 跟随首帧画幅；分辨率档位按短边就近（1080p/720p，快照 constraints）。
          ratio: 'adaptive',
          resolution:
            Math.min(request.resolution.width, request.resolution.height) >= 1080
              ? '1080p'
              : '720p',
          return_url: true,
          watermark: true,
        }),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        method: 'POST',
        redirect: 'error',
        signal: invocationSignal,
      });
      const { bodyText, truncated } = await readBodyCapped(response);
      const raw: VideoRawResponse = Object.freeze({
        bodyText,
        httpStatus: response.status,
        truncated,
      });
      if (!response.ok) {
        throw new SeedanceAdapterError(this.#normalizeStatus(response.status), raw);
      }
      let payload: SeedanceTaskResponse;
      try {
        payload = JSON.parse(bodyText) as SeedanceTaskResponse;
      } catch {
        throw new SeedanceAdapterError(
          normalized('MODEL_INVALID_RESPONSE', false, '重新生成或稍后重试'),
          raw,
        );
      }
      // ASYNC 形态（spec 不变式）：providerTaskId 由调用方先持久化再轮询；
      // submit 响应原文不随 submission 返回——证据由 SUBMIT 行快照 + poll usage 收口。
      if (typeof payload.id !== 'string' || payload.id.length === 0) {
        throw new SeedanceAdapterError(
          normalized('MODEL_INVALID_RESPONSE', false, '重新生成或稍后重试'),
          raw,
        );
      }
      return Object.freeze({ kind: 'ASYNC', providerTaskId: payload.id });
    } catch (error) {
      throw this.#wrapTransportError(error, signal);
    }
  }

  public async poll(providerTaskId: string, signal: AbortSignal): Promise<VideoTaskStatus> {
    const apiKey = await this.#credentialPort.loadCredential(this.#credentialId);
    try {
      const invocationSignal = AbortSignal.any([
        signal,
        this.#timeoutSignal(SEEDANCE_VIDEO_SEGMENT_TIMEOUT_MS),
      ]);
      if (invocationSignal.aborted) throw invocationSignal.reason;
      const response = await this.#fetch(
        `${this.#baseUrl}/api/v3/contents/generations/tasks/${providerTaskId}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          method: 'GET',
          redirect: 'error',
          signal: invocationSignal,
        },
      );
      const { bodyText, truncated } = await readBodyCapped(response);
      const raw: VideoRawResponse = Object.freeze({
        bodyText,
        httpStatus: response.status,
        truncated,
      });
      if (!response.ok) {
        throw new SeedanceAdapterError(this.#normalizeStatus(response.status), raw);
      }
      let payload: SeedanceTaskResponse;
      try {
        payload = JSON.parse(bodyText) as SeedanceTaskResponse;
      } catch {
        throw new SeedanceAdapterError(
          normalized('MODEL_INVALID_RESPONSE', false, '人工重试任务'),
          raw,
        );
      }
      if (payload.status === 'succeeded') {
        const videoUrl = payload.content?.video_url;
        if (typeof videoUrl !== 'string' || videoUrl.length === 0) {
          throw new SeedanceAdapterError(
            normalized('MODEL_INVALID_RESPONSE', false, '重新生成候选'),
            raw,
          );
        }
        const result: VideoResultRef = Object.freeze({
          actualDurationSec: actualDurationOf(payload.usage),
          height: null,
          providerRequestId: typeof payload.id === 'string' ? payload.id : providerTaskId,
          url: videoUrl,
          width: null,
        });
        return Object.freeze({
          result,
          state: 'SUCCEEDED',
          usage: {
            generatedImages: null,
            outputTokens:
              typeof payload.usage?.completion_tokens === 'number'
                ? payload.usage.completion_tokens
                : null,
          },
        });
      }
      if (payload.status === 'failed' || payload.status === 'cancelled') {
        const providerCode = typeof payload.error?.code === 'string' ? payload.error.code : '';
        return {
          detail: null,
          errorCode:
            providerCode.includes('content') || providerCode.includes('sensitive')
              ? 'MODEL_CONTENT_REJECTED'
              : 'MODEL_PROVIDER_ERROR',
          state: 'FAILED',
        };
      }
      // queued/running 及未知 status：PENDED 由调度器截止护栏兜底（不在此伪造终态）。
      return { state: 'PENDING' };
    } catch (error) {
      throw this.#wrapTransportError(error, signal, 'MODEL_NETWORK_ERROR', '等待后重试');
    }
  }

  public async download(resultRef: VideoResultRef, signal: AbortSignal): Promise<VideoDownload> {
    // 结果 URL 仅允许 https 且不带 userinfo；其余一律拒绝（Port：不可得 → MODEL_RESULT_UNAVAILABLE）。
    let parsed: URL;
    try {
      parsed = new URL(resultRef.url);
    } catch {
      throw new SeedanceAdapterError(normalized('MODEL_RESULT_UNAVAILABLE', false, '重新生成候选'));
    }
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
      throw new SeedanceAdapterError(normalized('MODEL_RESULT_UNAVAILABLE', false, '重新生成候选'));
    }
    try {
      const response = await this.#fetch(parsed.toString(), {
        headers: {},
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.any([signal, this.#timeoutSignal(SEEDANCE_VIDEO_SEGMENT_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        const { bodyText, truncated } = await readBodyCapped(response);
        throw new SeedanceAdapterError(
          normalized('MODEL_RESULT_UNAVAILABLE', false, '重新生成候选'),
          {
            bodyText,
            httpStatus: response.status,
            truncated,
          },
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!isMp4(bytes)) {
        throw new SeedanceAdapterError(normalized('MODEL_INVALID_RESPONSE', false, '重新生成候选'));
      }
      return { bytes, mimeType: 'video/mp4' };
    } catch (error) {
      throw this.#wrapTransportError(error, signal, 'MODEL_RESULT_UNAVAILABLE', '重新生成候选');
    }
  }

  public normalizeError(error: unknown): NormalizedModelError {
    return error instanceof SeedanceAdapterError
      ? error.normalized
      : normalized('MODEL_UNKNOWN', false, '检查 Provider 配置后重试');
  }

  public evidenceOf(error: unknown): ModelCallEvidence | null {
    return error instanceof SeedanceAdapterError ? error.evidence : null;
  }

  #assertRequestLegal(request: VideoGenerationRequest): void {
    const { durationSec, firstFrame, resolution } = request;
    if (
      !Number.isInteger(durationSec) ||
      durationSec < SEEDANCE_DURATION_RANGE[0] ||
      durationSec > SEEDANCE_DURATION_RANGE[1]
    ) {
      throw new SeedanceAdapterError(
        normalized('MODEL_INPUT_TOO_LARGE', false, '按时长档位调整后重试'),
      );
    }
    if (
      !Number.isInteger(resolution.height) ||
      !Number.isInteger(resolution.width) ||
      resolution.height <= 0 ||
      resolution.width <= 0 ||
      resolution.height > SEEDANCE_RESOLUTION_MAX_EDGE ||
      resolution.width > SEEDANCE_RESOLUTION_MAX_EDGE
    ) {
      throw new SeedanceAdapterError(
        normalized('MODEL_INPUT_TOO_LARGE', false, '按分辨率档位调整后重试'),
      );
    }
    if (
      firstFrame.bytes.byteLength === 0 ||
      firstFrame.bytes.byteLength > SEEDANCE_FIRST_FRAME_MAX_BYTES ||
      !SEEDANCE_FIRST_FRAME_MIME_TYPES.includes(firstFrame.mimeType)
    ) {
      throw new SeedanceAdapterError(
        normalized('MODEL_INPUT_TOO_LARGE', false, '调整首帧格式或大小后重试'),
      );
    }
  }

  #wrapTransportError(
    error: unknown,
    signal: AbortSignal,
    fallbackCode: NormalizedModelError['code'] = 'MODEL_NETWORK_ERROR',
    fallbackAction: string | null = '等待后重试',
  ): Error {
    if (error instanceof SeedanceAdapterError) return error;
    if (error instanceof SyntaxError) {
      return new SeedanceAdapterError(
        normalized('MODEL_INVALID_RESPONSE', false, '重新生成或稍后重试'),
      );
    }
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'TimeoutError') {
      return new SeedanceAdapterError(normalized('MODEL_TIMEOUT', false, '人工重试任务'));
    }
    if (name === 'AbortError' || signal.aborted) {
      return new SeedanceAdapterError(normalized('MODEL_CANCELLED', false, null));
    }
    return new SeedanceAdapterError(normalized(fallbackCode, true, fallbackAction));
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
    return normalized('MODEL_CONTENT_REJECTED', false, '调整提示词或首帧后重试');
  }
}
