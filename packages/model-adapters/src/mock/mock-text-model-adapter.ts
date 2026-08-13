import type {
  CredentialCheck,
  ModelErrorCode,
  NormalizedModelError,
  TextGenerationRequest,
  TextGenerationResult,
  TextModelPort,
} from '@jingxu/application';

export type MockTextModelStep =
  | Readonly<{
      afterMs?: number;
      finishReason?: string | null;
      kind: 'success';
      modelReported?: string | null;
      providerRequestId?: string | null;
      rawText: string;
      usage?: Readonly<{ inputTokens: number | null; outputTokens: number | null }>;
    }>
  | Readonly<{ afterMs?: number; error: NormalizedModelError; kind: 'error' }>
  | Readonly<{
      afterMs?: number;
      kind: 'invalid-json';
      providerRequestId?: string | null;
      rawText?: string;
    }>
  | Readonly<{ afterMs: number; kind: 'timeout' }>
  | Readonly<{
      afterMs?: number;
      kind: 'late-response';
      providerRequestId?: string | null;
      rawText: string;
    }>;

export interface MockTextModelAdapterOptions {
  readonly credentialCheck?: CredentialCheck;
  readonly now?: () => number;
  readonly requestId?: (sequence: number, now: number) => string;
  readonly steps: readonly MockTextModelStep[];
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class MockTextModelError extends Error {
  public readonly normalized: NormalizedModelError;

  public constructor(normalized: NormalizedModelError) {
    super(normalized.detail ?? normalized.code);
    this.name = 'MockTextModelError';
    this.normalized = normalized;
  }
}

const retryableCodes = new Set<ModelErrorCode>([
  'MODEL_NETWORK_ERROR',
  'MODEL_PROVIDER_ERROR',
  'MODEL_RATE_LIMITED',
  'MODEL_TIMEOUT',
]);

export const createMockModelError = (code: ModelErrorCode): NormalizedModelError =>
  Object.freeze({
    code,
    detail: `Mock outcome: ${code}.`,
    providerRequestId: null,
    retryable: retryableCodes.has(code),
    userAction: null,
  });

const defaultWait = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new MockTextModelError(createMockModelError('MODEL_CANCELLED')));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new MockTextModelError(createMockModelError('MODEL_CANCELLED')));
      },
      { once: true },
    );
  });
};

const freezeResult = (
  step: Extract<MockTextModelStep, { kind: 'success' | 'invalid-json' | 'late-response' }>,
  providerRequestId: string,
): TextGenerationResult =>
  Object.freeze({
    finishReason: step.kind === 'success' ? (step.finishReason ?? 'stop') : 'stop',
    modelReported:
      step.kind === 'success' ? (step.modelReported ?? 'mock-text-model') : 'mock-text-model',
    providerRequestId: step.providerRequestId ?? providerRequestId,
    rawText: step.kind === 'invalid-json' ? (step.rawText ?? '{') : step.rawText,
    usage:
      step.kind === 'success'
        ? (step.usage ?? Object.freeze({ inputTokens: null, outputTokens: null }))
        : Object.freeze({ inputTokens: null, outputTokens: null }),
  });

/**
 * 只用于确定性测试的 TextModelPort 实现。它消费声明式序列，不读取网络、凭据或用户目录。
 */
export class MockTextModelAdapter implements TextModelPort {
  readonly #credentialCheck: CredentialCheck;
  readonly #now: () => number;
  readonly #requestId: (sequence: number, now: number) => string;
  readonly #steps: readonly MockTextModelStep[];
  readonly #wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  #cursor = 0;

  public constructor(options: MockTextModelAdapterOptions) {
    this.#credentialCheck = options.credentialCheck ?? Object.freeze({ ok: true });
    this.#now = options.now ?? Date.now;
    this.#requestId =
      options.requestId ?? ((sequence, now) => `mock-request-${String(now)}-${String(sequence)}`);
    this.#steps = Object.freeze([...options.steps]);
    this.#wait = options.wait ?? defaultWait;
  }

  public validateCredential(): Promise<CredentialCheck> {
    return Promise.resolve(this.#credentialCheck);
  }

  public async generate(
    _request: TextGenerationRequest,
    signal: AbortSignal,
  ): Promise<TextGenerationResult> {
    const sequence = this.#cursor + 1;
    const step = this.#steps[this.#cursor];
    this.#cursor = sequence;
    if (step === undefined) {
      throw new MockTextModelError(createMockModelError('MODEL_UNKNOWN'));
    }

    const ignoresCancellation = step.kind === 'late-response';
    if (signal.aborted && !ignoresCancellation) {
      throw new MockTextModelError(createMockModelError('MODEL_CANCELLED'));
    }
    if ((step.afterMs ?? 0) > 0) {
      await this.#wait(
        step.afterMs ?? 0,
        ignoresCancellation ? new AbortController().signal : signal,
      );
    }
    if (step.kind === 'timeout') {
      throw new MockTextModelError(createMockModelError('MODEL_TIMEOUT'));
    }
    if (step.kind === 'error') {
      throw new MockTextModelError(step.error);
    }
    return freezeResult(step, this.#requestId(sequence, this.#now()));
  }

  public normalizeError(error: unknown): NormalizedModelError {
    if (error instanceof MockTextModelError) return error.normalized;
    return Object.freeze({
      code: 'MODEL_UNKNOWN',
      detail: 'Mock model call failed.',
      providerRequestId: null,
      retryable: false,
      userAction: null,
    });
  }
}
