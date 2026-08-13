import type {
  CredentialCheck,
  CredentialPort,
  NormalizedModelError,
  TextGenerationRequest,
  TextGenerationResult,
  TextModelPort,
} from '@jingxu/application';

export const QWEN_MODEL_ID = 'qwen3.7-plus-2026-05-26';
export const QWEN_INPUT_TOKEN_LIMIT = 64_000;
export const QWEN_INVOCATION_TIMEOUT_MS = 120_000;
const WORKSPACE_ID = /^[A-Za-z0-9-]+$/u;

export const deriveQwenBaseUrl = (workspaceId: string): string => {
  if (!WORKSPACE_ID.test(workspaceId)) throw new Error('MODEL_CONFIGURATION_INVALID');
  return `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`;
};

interface QwenResponse {
  readonly choices?: readonly {
    readonly finish_reason?: unknown;
    readonly message?: { readonly content?: unknown };
  }[];
  readonly id?: unknown;
  readonly model?: unknown;
  readonly usage?: { readonly completion_tokens?: unknown; readonly prompt_tokens?: unknown };
}

class QwenAdapterError extends Error {
  public constructor(public readonly normalized: NormalizedModelError) {
    super(normalized.code);
    this.name = 'QwenAdapterError';
  }
}

export interface QwenTextModelAdapterOptions {
  readonly countInputTokens?: (serializedInput: string) => number;
  readonly credentialId: string;
  readonly credentialPort: CredentialPort;
  readonly fetch?: typeof globalThis.fetch;
  readonly modelId?: string;
  readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
  readonly workspaceId: string;
}

const normalized = (
  code: NormalizedModelError['code'],
  retryable: boolean,
  userAction: string | null,
): NormalizedModelError => ({ code, detail: null, providerRequestId: null, retryable, userAction });

const defaultTokenCounter = (serializedInput: string): number =>
  new TextEncoder().encode(serializedInput).byteLength;

/** 百炼 OpenAI 兼容边界；实例在 Main 中绑定凭据引用，Application DTO 不含 Key。 */
export class QwenTextModelAdapter implements TextModelPort {
  readonly #baseUrl: string;
  readonly #countInputTokens: (serializedInput: string) => number;
  readonly #credentialId: string;
  readonly #credentialPort: CredentialPort;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutSignal: (milliseconds: number) => AbortSignal;

  public constructor(options: QwenTextModelAdapterOptions) {
    if ((options.modelId ?? QWEN_MODEL_ID) !== QWEN_MODEL_ID) {
      throw new Error('MODEL_CONFIGURATION_INVALID');
    }
    this.#baseUrl = deriveQwenBaseUrl(options.workspaceId);
    this.#credentialId = options.credentialId;
    this.#credentialPort = options.credentialPort;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#countInputTokens = options.countInputTokens ?? defaultTokenCounter;
    this.#timeoutSignal =
      options.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  }

  public async validateCredential(): Promise<CredentialCheck> {
    try {
      await this.generate(
        {
          candidateSchemaId: 'credential-check/v1',
          finalSchemaId: 'credential-check/v1',
          invocationId: 'credential-check',
          parameters: {},
          promptTemplateVersion: 'credential-check/v1',
          stage: 'CONCEPT',
          systemPrompt: 'Return only {"ok":true}.',
          userPayload: { check: true },
        },
        new AbortController().signal,
      );
      return { ok: true };
    } catch (error) {
      const failure = this.normalizeError(error);
      return { detail: null, errorCode: failure.code, ok: false };
    }
  }

  public async generate(
    request: TextGenerationRequest,
    signal: AbortSignal,
  ): Promise<TextGenerationResult> {
    const messages = [
      { content: request.systemPrompt, role: 'system' },
      { content: JSON.stringify(request.userPayload), role: 'user' },
    ];
    if (this.#countInputTokens(JSON.stringify(messages)) > QWEN_INPUT_TOKEN_LIMIT) {
      throw new QwenAdapterError(
        normalized('MODEL_INPUT_TOO_LARGE', false, '缩短或拆分输入后重试'),
      );
    }

    const apiKey = await this.#credentialPort.loadCredential(this.#credentialId);
    try {
      const temperature = request.parameters.temperature;
      const topP = request.parameters.top_p;
      const invocationSignal = AbortSignal.any([
        signal,
        this.#timeoutSignal(QWEN_INVOCATION_TIMEOUT_MS),
      ]);
      if (invocationSignal.aborted) throw invocationSignal.reason;
      const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        body: JSON.stringify({
          enable_thinking: false,
          messages,
          model: QWEN_MODEL_ID,
          response_format: { type: 'json_object' },
          ...(typeof temperature === 'number' ? { temperature } : {}),
          ...(typeof topP === 'number' ? { top_p: topP } : {}),
        }),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        method: 'POST',
        redirect: 'error',
        signal: invocationSignal,
      });
      if (!response.ok) throw new QwenAdapterError(this.#normalizeStatus(response.status));
      const payload = (await response.json()) as QwenResponse;
      const choice = payload.choices?.[0];
      if (typeof choice?.message?.content !== 'string') {
        throw new QwenAdapterError(
          normalized('MODEL_INVALID_RESPONSE', false, '重新生成或进行一次结构修复'),
        );
      }
      try {
        JSON.parse(choice.message.content);
      } catch {
        throw new QwenAdapterError(
          normalized('MODEL_INVALID_RESPONSE', false, '重新生成或进行一次结构修复'),
        );
      }
      return {
        finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
        modelReported: typeof payload.model === 'string' ? payload.model : null,
        providerRequestId: typeof payload.id === 'string' ? payload.id : null,
        rawText: choice.message.content,
        usage: {
          inputTokens:
            typeof payload.usage?.prompt_tokens === 'number' ? payload.usage.prompt_tokens : null,
          outputTokens:
            typeof payload.usage?.completion_tokens === 'number'
              ? payload.usage.completion_tokens
              : null,
        },
      };
    } catch (error) {
      if (error instanceof QwenAdapterError) throw error;
      if (error instanceof SyntaxError) {
        throw new QwenAdapterError(
          normalized('MODEL_INVALID_RESPONSE', false, '重新生成或进行一次结构修复'),
        );
      }
      const name = error instanceof DOMException ? error.name : '';
      throw new QwenAdapterError(
        name === 'TimeoutError'
          ? normalized('MODEL_TIMEOUT', false, '人工重试任务')
          : name === 'AbortError' || signal.aborted
            ? normalized('MODEL_CANCELLED', false, null)
            : normalized('MODEL_NETWORK_ERROR', true, '等待后重试'),
      );
    }
  }

  public normalizeError(error: unknown): NormalizedModelError {
    return error instanceof QwenAdapterError
      ? error.normalized
      : normalized('MODEL_UNKNOWN', false, '检查 Provider 配置后重试');
  }

  #normalizeStatus(status: number): NormalizedModelError {
    if (status === 401 || status === 403) {
      return normalized('MODEL_CREDENTIAL_INVALID', false, '重新配置 API Key');
    }
    if (status === 429) return normalized('MODEL_RATE_LIMITED', true, '等待后重试');
    if (status >= 500) return normalized('MODEL_PROVIDER_ERROR', true, '等待后重试');
    if (status === 413) {
      return normalized('MODEL_CONTEXT_LIMIT', false, '缩短或拆分输入后重试');
    }
    if (status === 400 || status === 422) {
      return normalized('MODEL_CONTENT_REJECTED', false, '检查内容与 Provider 规则');
    }
    return normalized('MODEL_PROVIDER_ERROR', false, '检查 Provider 配置后重试');
  }
}
