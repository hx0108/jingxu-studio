import type {
  CredentialCheck,
  CredentialPort,
  ModelCallEvidence,
  NormalizedModelError,
  VideoDownload,
  VideoGenerationRequest,
  VideoModelPort,
  VideoResultRef,
  VideoTaskStatus,
  VideoTaskSubmission,
} from '@jingxu/application';

import {
  AGNES_VIDEO_CREATE_URL,
  AGNES_VIDEO_DOWNLOAD_DOMAIN_SUFFIXES,
  AGNES_VIDEO_DURATION_SEC,
  AGNES_VIDEO_POLL_BASE_URL,
  AGNES_VIDEO_SIZE,
  isAgnesVideo25Flash,
  isAgnesVideoModelId,
  type AgnesVideoModelId,
} from './agnes-video-models';

const RESPONSE_CAP = 65_536;
const MAX_FIRST_FRAME_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const normalized = (
  code: NormalizedModelError['code'],
  retryable: boolean,
  userAction: string | null,
): NormalizedModelError => ({ code, detail: null, providerRequestId: null, retryable, userAction });

class AgnesAdapterError extends Error {
  public constructor(
    readonly normalized: NormalizedModelError,
    readonly evidence: ModelCallEvidence = { bodyText: null, httpStatus: null, truncated: false },
  ) {
    super(normalized.code);
    this.name = 'AgnesAdapterError';
  }
}

const readBody = async (response: Response): Promise<{ bodyText: string; truncated: boolean }> => {
  const bodyText = await response.text();
  return bodyText.length > RESPONSE_CAP
    ? { bodyText: bodyText.slice(0, RESPONSE_CAP), truncated: true }
    : { bodyText, truncated: false };
};

const base64Of = (bytes: Uint8Array): string => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const charAt = (index: number): string => alphabet[index] ?? 'A';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    output += charAt((a >> 2) & 63);
    output += charAt(((a & 3) << 4) | ((b ?? 0) >> 4));
    output += b === undefined ? '=' : charAt(((b & 15) << 2) | ((c ?? 0) >> 6));
    output += c === undefined ? '=' : charAt(c & 63);
  }
  return output;
};

const isMp4 = (bytes: Uint8Array): boolean =>
  bytes.length >= 12 &&
  bytes[4] === 0x66 &&
  bytes[5] === 0x74 &&
  bytes[6] === 0x79 &&
  bytes[7] === 0x70;

interface AgnesTaskResponse {
  readonly code?: unknown;
  readonly error?: unknown;
  readonly message?: unknown;
  readonly model?: unknown;
  readonly request_id?: unknown;
  readonly seconds?: unknown;
  readonly status?: unknown;
  readonly url?: unknown;
  readonly video_id?: unknown;
}

export interface AgnesVideoModelAdapterOptions {
  readonly credentialId: string;
  readonly credentialPort: CredentialPort;
  readonly fetch?: typeof globalThis.fetch;
  /** 本适配器实例服务的冻结模型；由 Main 按任务冻结的 model_id 解析注入（design D4/D5b）。 */
  readonly modelId: AgnesVideoModelId;
  readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
}

/**
 * Agnes AI 视频适配器（OpenAI Videos 兼容异步任务）。请求参数在此边界冻结：
 * 固定 API 域、5 秒时长、720P、data URL 首帧、按模型二选一的 i2v 请求形状；
 * 调用方无法用 provider DTO 绕过这些限制。
 */
export class AgnesVideoModelAdapter implements VideoModelPort {
  readonly #credentialId: string;
  readonly #credentialPort: CredentialPort;
  readonly #fetch: typeof globalThis.fetch;
  readonly #modelId: AgnesVideoModelId;
  readonly #timeoutSignal: (milliseconds: number) => AbortSignal;

  public constructor(options: AgnesVideoModelAdapterOptions) {
    if (!isAgnesVideoModelId(options.modelId)) throw new Error('AGNES_MODEL_INVALID');
    this.#credentialId = options.credentialId;
    this.#credentialPort = options.credentialPort;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#modelId = options.modelId;
    this.#timeoutSignal =
      options.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  }

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
    this.#assertRequest(request);
    return this.#request(async (apiKey, invocationSignal) => {
      const firstFrame = `data:${request.firstFrame.mimeType};base64,${base64Of(request.firstFrame.bytes)}`;
      // 两模型 i2v 请求形状按 2026-09-19 探针冻结：V2.0 走 image+ti2vid（seconds
      // 省略用服务端默认 5.0）；2.5 Flash 走 keyframe+first_frame 并显式 720P。
      const body = isAgnesVideo25Flash(request.modelId)
        ? {
            first_frame: firstFrame,
            mode: 'keyframe',
            model: request.modelId,
            prompt: request.prompt,
            seconds: String(AGNES_VIDEO_DURATION_SEC),
            size: AGNES_VIDEO_SIZE,
          }
        : {
            image: firstFrame,
            mode: 'ti2vid',
            model: request.modelId,
            prompt: request.prompt,
          };
      const response = await this.#fetch(AGNES_VIDEO_CREATE_URL, {
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        redirect: 'error',
        signal: invocationSignal,
      });
      const evidence = await this.#evidence(response);
      if (!response.ok) throw new AgnesAdapterError(this.#status(response.status), evidence);
      const payload = this.#parse(evidence);
      const videoId = payload.video_id;
      if (typeof videoId !== 'string' || videoId === '')
        throw new AgnesAdapterError(
          normalized('MODEL_INVALID_RESPONSE', false, '重新生成候选'),
          evidence,
        );
      return { kind: 'ASYNC', providerTaskId: videoId };
    }, signal);
  }

  public async poll(providerTaskId: string, signal: AbortSignal): Promise<VideoTaskStatus> {
    return this.#request(async (apiKey, invocationSignal) => {
      // 非 text 模式（keyframe/ti2vid）轮询 MUST 带 model_name（官方文档 + 实测）。
      // 适配器统一携带：video_id 与模型都来自冻结注册表，无 Renderer 输入。
      const model = this.#modelOfTask(providerTaskId);
      const query = `video_id=${encodeURIComponent(providerTaskId)}&model_name=${encodeURIComponent(model)}`;
      const response = await this.#fetch(`${AGNES_VIDEO_POLL_BASE_URL}?${query}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        method: 'GET',
        redirect: 'error',
        signal: invocationSignal,
      });
      const evidence = await this.#evidence(response);
      if (!response.ok) throw new AgnesAdapterError(this.#status(response.status), evidence);
      const payload = this.#parse(evidence);
      const status = payload.status;
      if (status === 'completed') {
        const url = payload.url;
        if (typeof url !== 'string' || url === '')
          throw new AgnesAdapterError(
            normalized('MODEL_INVALID_RESPONSE', false, '重新生成候选'),
            evidence,
          );
        const duration = payload.seconds;
        return {
          result: {
            actualDurationSec: typeof duration === 'string' ? Number.parseFloat(duration) : null,
            height: null,
            providerRequestId:
              typeof payload.request_id === 'string' ? payload.request_id : providerTaskId,
            url,
            width: null,
          },
          state: 'SUCCEEDED',
          usage: { generatedImages: null, outputTokens: null },
        };
      }
      if (status === 'failed') {
        return { detail: null, errorCode: this.#failureCode(payload), state: 'FAILED' };
      }
      // pending（文档外实测值）/ queued / in_progress 一律视为进行中。
      if (status === 'pending' || status === 'queued' || status === 'in_progress') {
        return { state: 'PENDING' };
      }
      throw new AgnesAdapterError(
        normalized('MODEL_RESULT_UNAVAILABLE', false, '重新生成候选'),
        evidence,
      );
    }, signal);
  }

  public async download(result: VideoResultRef, signal: AbortSignal): Promise<VideoDownload> {
    let url: URL;
    try {
      url = new URL(result.url);
    } catch {
      throw new AgnesAdapterError(normalized('MODEL_RESULT_UNAVAILABLE', false, '重新生成候选'));
    }
    const hostAllowed = (AGNES_VIDEO_DOWNLOAD_DOMAIN_SUFFIXES as readonly string[]).some(
      (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
    );
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || !hostAllowed)
      throw new AgnesAdapterError(normalized('MODEL_RESULT_UNAVAILABLE', false, '重新生成候选'));
    try {
      const response = await this.#fetch(url.toString(), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.any([signal, this.#timeoutSignal(120_000)]),
      });
      if (!response.ok)
        throw new AgnesAdapterError(
          normalized('MODEL_RESULT_UNAVAILABLE', false, '重新生成候选'),
          await this.#evidence(response),
        );
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!isMp4(bytes))
        throw new AgnesAdapterError(normalized('MODEL_INVALID_RESPONSE', false, '重新生成候选'));
      return { bytes, mimeType: 'video/mp4' };
    } catch (error) {
      throw this.#wrap(error, signal, 'MODEL_RESULT_UNAVAILABLE');
    }
  }

  public normalizeError(error: unknown): NormalizedModelError {
    return error instanceof AgnesAdapterError
      ? error.normalized
      : normalized('MODEL_UNKNOWN', false, '检查 Provider 配置后重试');
  }
  public evidenceOf(error: unknown): ModelCallEvidence | null {
    return error instanceof AgnesAdapterError ? error.evidence : null;
  }

  /** providerTaskId 即 video_id；轮询 model_name 用适配器冻结的模型（构造注入）。 */
  #modelOfTask(_providerTaskId: string): string {
    return this.#modelId;
  }

  async #request<T>(
    work: (apiKey: string, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    try {
      const combined = AbortSignal.any([signal, this.#timeoutSignal(120_000)]);
      if (combined.aborted) throw combined.reason;
      return await work(await this.#credentialPort.loadCredential(this.#credentialId), combined);
    } catch (error) {
      throw this.#wrap(error, signal, 'MODEL_NETWORK_ERROR');
    }
  }
  async #evidence(response: Response): Promise<ModelCallEvidence> {
    const body = await readBody(response);
    return { ...body, httpStatus: response.status };
  }
  #parse(evidence: ModelCallEvidence): AgnesTaskResponse {
    try {
      return JSON.parse(evidence.bodyText ?? '') as AgnesTaskResponse;
    } catch {
      throw new AgnesAdapterError(
        normalized('MODEL_INVALID_RESPONSE', false, '重新生成候选'),
        evidence,
      );
    }
  }
  #assertRequest(request: VideoGenerationRequest): void {
    if (
      !isAgnesVideoModelId(request.modelId) ||
      request.durationSec !== AGNES_VIDEO_DURATION_SEC ||
      request.firstFrame.bytes.byteLength === 0 ||
      request.firstFrame.bytes.byteLength > MAX_FIRST_FRAME_BYTES ||
      !IMAGE_TYPES.includes(request.firstFrame.mimeType as (typeof IMAGE_TYPES)[number])
    )
      throw new AgnesAdapterError(
        normalized('MODEL_INPUT_TOO_LARGE', false, '检查 Agnes 视频参数后重试'),
      );
  }
  #failureCode(payload: AgnesTaskResponse): NormalizedModelError['code'] {
    const error = payload.error;
    const text =
      typeof error === 'string'
        ? error.toLowerCase()
        : typeof payload.message === 'string'
          ? payload.message.toLowerCase()
          : '';
    return text.includes('content') || text.includes('sensitive')
      ? 'MODEL_CONTENT_REJECTED'
      : 'MODEL_PROVIDER_ERROR';
  }
  #status(status: number): NormalizedModelError {
    if (status === 401 || status === 403)
      return normalized('MODEL_CREDENTIAL_INVALID', false, '重新配置 Agnes API Key');
    if (status === 429)
      // 免费档 1 RPM 下预期常见：可重试，交既有调度器退避（design.md D5b）。
      return normalized('MODEL_RATE_LIMITED', true, '等待约一分钟后重试');
    if (status >= 500) return normalized('MODEL_PROVIDER_ERROR', true, '等待后重试');
    if (status === 404)
      return normalized('MODEL_MODEL_UNAVAILABLE', false, '确认 Agnes 模型可用后重试');
    if (status === 413)
      return normalized('MODEL_INPUT_TOO_LARGE', false, '检查首帧或请求参数后重试');
    return normalized('MODEL_CONTENT_REJECTED', false, '调整提示词或首帧后重试');
  }
  #wrap(error: unknown, signal: AbortSignal, fallback: NormalizedModelError['code']): Error {
    if (error instanceof AgnesAdapterError) return error;
    if (error instanceof DOMException && error.name === 'TimeoutError')
      return new AgnesAdapterError(normalized('MODEL_TIMEOUT', false, '人工重试任务'));
    if ((error instanceof DOMException && error.name === 'AbortError') || signal.aborted)
      return new AgnesAdapterError(normalized('MODEL_CANCELLED', false, null));
    return new AgnesAdapterError(normalized(fallback, true, '等待后重试'));
  }
}
