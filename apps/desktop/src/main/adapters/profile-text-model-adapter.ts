import type {
  CredentialCheck,
  NormalizedModelError,
  ProviderProfile,
  ProviderProfileRepositoryPort,
  TextGenerationRequest,
  TextGenerationResult,
  TextModelPort,
} from '@jingxu/application';

interface ProfileTextModelAdapterOptions {
  readonly createAdapter: (profile: ProviderProfile) => TextModelPort;
  readonly profileId: string;
  readonly profiles: ProviderProfileRepositoryPort;
}

class ProfileTextModelError extends Error {
  public constructor(public readonly normalized: NormalizedModelError) {
    super(normalized.code);
    this.name = 'ProfileTextModelError';
  }
}

const configurationError = (code: NormalizedModelError['code']): ProfileTextModelError =>
  new ProfileTextModelError({
    code,
    detail: null,
    providerRequestId: null,
    retryable: false,
    userAction: '请先完成并验证文本模型配置。',
  });

/** Resolves the current persisted Provider profile before every paid request. */
export class ProfileTextModelAdapter implements TextModelPort {
  readonly #options: ProfileTextModelAdapterOptions;

  public constructor(options: ProfileTextModelAdapterOptions) {
    this.#options = options;
  }

  public async validateCredential(): Promise<CredentialCheck> {
    const adapter = await this.#resolve();
    return adapter.validateCredential();
  }

  public async generate(
    request: TextGenerationRequest,
    signal: AbortSignal,
  ): Promise<TextGenerationResult> {
    const adapter = await this.#resolve();
    try {
      return await adapter.generate(request, signal);
    } catch (error) {
      throw new ProfileTextModelError(adapter.normalizeError(error));
    }
  }

  public normalizeError(error: unknown): NormalizedModelError {
    if (error instanceof ProfileTextModelError) return error.normalized;
    return {
      code: 'MODEL_UNKNOWN',
      detail: null,
      providerRequestId: null,
      retryable: false,
      userAction: null,
    };
  }

  async #resolve(): Promise<TextModelPort> {
    const profile = await this.#options.profiles.findById(this.#options.profileId);
    if (profile?.enabled !== true) throw configurationError('MODEL_CREDENTIAL_INVALID');
    if (profile.credentialRef === null || profile.config.lastValidatedAt === null) {
      throw configurationError('MODEL_CREDENTIAL_INVALID');
    }
    try {
      return this.#options.createAdapter(profile);
    } catch {
      throw configurationError('MODEL_UNKNOWN');
    }
  }
}
