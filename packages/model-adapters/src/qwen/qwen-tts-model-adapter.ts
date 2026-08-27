import type {
  CredentialCheck,
  CredentialPort,
  ModelCallEvidence,
  NormalizedModelError,
  TtsModelPort,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from '@jingxu/application';

export const QWEN_TTS_MODEL_ID = 'qwen3-tts-instruct-flash';
/** 2.2 实测：qwen3-tts 文本长度区间 [0,600] 字符（400 InvalidParameter）。 */
export const QWEN_TTS_TEXT_CHAR_LIMIT = 600;
/** 单段合成（POST 合成 + OSS 下载）总超时；600 字符级合成远低于此。 */
export const QWEN_TTS_INVOCATION_TIMEOUT_MS = 120_000;
/** 原生 multimodal-generation 路由（2.2 实测；compatible-mode 无 audio/speech）。 */
const GENERATION_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

/**
 * 2.2 实测响应形状：成功时顶层仅 output/usage/request_id（无 status_code 错误
 * 信封字段）；非流式音频经 OSS url 交付（24h 有效、24kHz 单声道 16bit WAV），
 * audio.data 为空串——字节须由适配器下载，URL 不出适配器边界。
 */
interface QwenTtsResponse {
  readonly output?: {
    readonly audio?: { readonly id?: unknown; readonly url?: unknown };
    readonly finish_reason?: unknown;
  };
  readonly request_id?: unknown;
  readonly usage?: { readonly characters?: unknown; readonly output_tokens?: unknown };
}

class QwenTtsAdapterError extends Error {
  /**
   * 原始响应证据（main-only 留证通道）：本地校验失败未发请求时为全 null；
   * OSS 下载段失败时 bodyText 为 null（二进制体不入文本留证）。
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
    this.name = 'QwenTtsAdapterError';
  }
}

/** 响应体读取上限（防御性截断；实际响应远小于此）。 */
const RESPONSE_BODY_READ_CAP = 65_536;

const readBodyCapped = async (
  response: Response,
): Promise<{ bodyText: string; truncated: boolean }> => {
  const raw = await response.text();
  return raw.length > RESPONSE_BODY_READ_CAP
    ? { bodyText: raw.slice(0, RESPONSE_BODY_READ_CAP), truncated: true }
    : { bodyText: raw, truncated: false };
};

export interface QwenTtsModelAdapterOptions {
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

const isRiff = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x52 &&
  bytes[1] === 0x49 &&
  bytes[2] === 0x46 &&
  bytes[3] === 0x46;

/** DashScope qwen3-tts 边界；实例在 Main 中绑定凭据引用，Application DTO 不含 Key。 */
export class QwenTtsModelAdapter implements TtsModelPort {
  readonly #credentialId: string;
  readonly #credentialPort: CredentialPort;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutSignal: (milliseconds: number) => AbortSignal;

  public constructor(options: QwenTtsModelAdapterOptions) {
    if ((options.modelId ?? QWEN_TTS_MODEL_ID) !== QWEN_TTS_MODEL_ID) {
      throw new Error('MODEL_CONFIGURATION_INVALID');
    }
    this.#credentialId = options.credentialId;
    this.#credentialPort = options.credentialPort;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutSignal =
      options.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  }

  public async validateCredential(): Promise<CredentialCheck> {
    try {
      await this.#credentialPort.loadCredential(this.#credentialId);
      return { ok: true };
    } catch (error) {
      const failure = this.normalizeError(error);
      return { detail: null, errorCode: failure.code, ok: false };
    }
  }

  public async synthesize(
    request: TtsSynthesisRequest,
    signal: AbortSignal,
  ): Promise<TtsSynthesisResult> {
    if (request.spokenText.length > QWEN_TTS_TEXT_CHAR_LIMIT) {
      throw new QwenTtsAdapterError(
        normalized('MODEL_INPUT_TOO_LARGE', false, '缩短台词或拆分镜头后重试'),
      );
    }
    if (request.spokenText.trim().length === 0) {
      throw new QwenTtsAdapterError(
        normalized('MODEL_CONTENT_REJECTED', false, '检查台词内容后重试'),
      );
    }

    const apiKey = await this.#credentialPort.loadCredential(this.#credentialId);
    const invocationSignal = AbortSignal.any([
      signal,
      this.#timeoutSignal(QWEN_TTS_INVOCATION_TIMEOUT_MS),
    ]);
    if (invocationSignal.aborted) throw invocationSignal.reason;

    try {
      const response = await this.#fetch(GENERATION_URL, {
        body: JSON.stringify({
          input: { text: request.spokenText, voice: request.voiceId },
          model: QWEN_TTS_MODEL_ID,
        }),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        method: 'POST',
        redirect: 'error',
        signal: invocationSignal,
      });
      const { bodyText, truncated } = await readBodyCapped(response);
      const evidence: ModelCallEvidence = { bodyText, httpStatus: response.status, truncated };
      if (!response.ok) {
        throw new QwenTtsAdapterError(this.#normalizeStatus(response.status), evidence);
      }
      let payload: QwenTtsResponse;
      try {
        payload = JSON.parse(bodyText) as QwenTtsResponse;
      } catch {
        throw new QwenTtsAdapterError(
          normalized('MODEL_INVALID_RESPONSE', false, '重新生成配音'),
          evidence,
        );
      }
      const downloadUrl = payload.output?.audio?.url;
      if (typeof downloadUrl !== 'string' || downloadUrl.length === 0) {
        throw new QwenTtsAdapterError(
          normalized('MODEL_INVALID_RESPONSE', false, '重新生成配音'),
          evidence,
        );
      }

      const audioResponse = await this.#fetch(downloadUrl, {
        headers: { Accept: 'audio/wav' },
        method: 'GET',
        redirect: 'error',
        signal: invocationSignal,
      });
      if (!audioResponse.ok) {
        throw new QwenTtsAdapterError(this.#normalizeStatus(audioResponse.status), {
          bodyText: null,
          httpStatus: audioResponse.status,
          truncated: false,
        });
      }
      const bytes = new Uint8Array(await audioResponse.arrayBuffer());
      if (!isRiff(bytes)) {
        throw new QwenTtsAdapterError(normalized('MODEL_INVALID_RESPONSE', false, '重新生成配音'), {
          bodyText: null,
          httpStatus: audioResponse.status,
          truncated: false,
        });
      }

      const usage = payload.usage;
      return {
        audio: { bytes, mimeType: 'audio/wav' },
        httpStatus: response.status,
        providerRequestId:
          typeof payload.output?.audio?.id === 'string'
            ? payload.output.audio.id
            : typeof payload.request_id === 'string'
              ? payload.request_id
              : null,
        usage: {
          outputCharacters: typeof usage?.characters === 'number' ? usage.characters : null,
          outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : null,
        },
      };
    } catch (error) {
      if (error instanceof QwenTtsAdapterError) throw error;
      if (error instanceof SyntaxError) {
        throw new QwenTtsAdapterError(normalized('MODEL_INVALID_RESPONSE', false, '重新生成配音'));
      }
      const name = error instanceof DOMException ? error.name : '';
      throw new QwenTtsAdapterError(
        name === 'TimeoutError'
          ? normalized('MODEL_TIMEOUT', false, '人工重试任务')
          : name === 'AbortError' || signal.aborted
            ? normalized('MODEL_CANCELLED', false, null)
            : normalized('MODEL_NETWORK_ERROR', true, '等待后重试'),
      );
    }
  }

  public normalizeError(error: unknown): NormalizedModelError {
    return error instanceof QwenTtsAdapterError
      ? error.normalized
      : normalized('MODEL_UNKNOWN', false, '检查 Provider 配置后重试');
  }

  public evidenceOf(error: unknown): ModelCallEvidence | null {
    return error instanceof QwenTtsAdapterError ? error.evidence : null;
  }

  #normalizeStatus(status: number): NormalizedModelError {
    if (status === 401 || status === 403) {
      return normalized('MODEL_CREDENTIAL_INVALID', false, '重新配置 API Key');
    }
    if (status === 429) return normalized('MODEL_RATE_LIMITED', true, '等待后重试');
    if (status >= 500) return normalized('MODEL_PROVIDER_ERROR', true, '等待后重试');
    if (status === 400 || status === 422) {
      return normalized('MODEL_CONTENT_REJECTED', false, '检查台词与音色后重试');
    }
    return normalized('MODEL_PROVIDER_ERROR', false, '重新生成配音');
  }
}
