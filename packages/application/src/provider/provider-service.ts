import type { CredentialPort } from '../ports/credential';
import type { TextModelPort } from '../ports/text-model';
import type {
  ProviderProfile,
  ProviderProfileDefaults,
  ProviderProfileRepositoryPort,
  ProviderProfileView,
  ProviderUnitOfWorkPort,
} from './provider-types';

export interface ProviderServiceDependencies {
  readonly clock: () => string;
  readonly credentials: CredentialPort;
  readonly defaults: ProviderProfileDefaults;
  readonly profiles: ProviderProfileRepositoryPort;
  readonly textModelFactory: (profile: ProviderProfile) => TextModelPort;
  readonly unitOfWork: ProviderUnitOfWorkPort;
}

const toView = (profile: ProviderProfile): ProviderProfileView => ({
  configured: profile.credentialRef !== null,
  enabled: profile.enabled,
  last4: profile.credentialLast4,
  lastValidatedAt: profile.config.lastValidatedAt,
  modelId: profile.modelId,
  modelSnapshotDate: profile.modelSnapshotDate,
  provider: profile.provider,
  region: profile.region,
  versionId: profile.id,
  workspaceId: profile.workspaceId,
});

/** Provider 配置与凭据生命周期；所有返回 DTO 均不含明文 Key。 */
export class ProviderService {
  readonly #dependencies: ProviderServiceDependencies;
  public constructor(dependencies: ProviderServiceDependencies) {
    this.#dependencies = dependencies;
  }

  public async getProfile(profileId: string): Promise<ProviderProfileView> {
    const profile = await this.#dependencies.profiles.findById(profileId);
    return toView(profile ?? this.#defaultProfile(profileId));
  }

  /** 更新已存在行的启用状态与工作区；行不存在则拒绝（凭据先于配置）。 */
  public async saveProfile(
    profileId: string,
    workspaceId: string,
    enabled: boolean,
  ): Promise<ProviderProfileView> {
    const profile = await this.#requireProfile(profileId);
    const next: ProviderProfile = {
      ...profile,
      config:
        workspaceId === profile.workspaceId
          ? profile.config
          : { ...profile.config, lastValidatedAt: null },
      enabled,
      workspaceId,
    };
    await this.#dependencies.unitOfWork.run(async ({ profiles }) => {
      await profiles.save(next);
    });
    return toView(next);
  }

  /** 首次落行或更换凭据；凭据写入失败回滚密文与行。 */
  public async saveCredential(profileId: string, plaintext: string): Promise<ProviderProfileView> {
    const existing = await this.#dependencies.profiles.findById(profileId);
    const base = existing ?? this.#defaultProfile(profileId);
    const credential = await this.#dependencies.credentials.saveCredential(plaintext);
    const next: ProviderProfile = {
      ...base,
      credentialLast4: credential.last4,
      credentialRef: credential.id,
    };
    try {
      await this.#dependencies.unitOfWork.run(async ({ profiles }) => {
        await profiles.save(next);
      });
    } catch (error) {
      await this.#dependencies.credentials.deleteCredential(credential.id);
      throw error;
    }
    return toView(next);
  }

  public async testCredential(
    profileId: string,
  ): Promise<Awaited<ReturnType<TextModelPort['validateCredential']>>> {
    const profile = await this.#requireProfile(profileId);
    if (profile.credentialRef === null) throw new Error('PROVIDER_CREDENTIAL_MISSING');
    const result = await this.#dependencies.textModelFactory(profile).validateCredential();
    if (result.ok) {
      await this.#dependencies.unitOfWork.run(async ({ profiles }) => {
        await profiles.save({
          ...profile,
          config: { ...profile.config, lastValidatedAt: this.#dependencies.clock() },
        });
      });
    }
    return result;
  }

  /** 删除密文与整行并写审计；返回未配置默认视图。 */
  public async deleteCredential(profileId: string): Promise<ProviderProfileView> {
    const profile = await this.#requireProfile(profileId);
    if (profile.credentialRef !== null) {
      await this.#dependencies.credentials.deleteCredential(profile.credentialRef);
      await this.#dependencies.unitOfWork.run(async ({ audit, profiles }) => {
        await profiles.delete(profileId);
        await audit.recordCredentialDeleted(profileId, this.#dependencies.clock());
      });
    }
    return toView(this.#defaultProfile(profileId));
  }

  async #requireProfile(profileId: string): Promise<ProviderProfile> {
    const profile = await this.#dependencies.profiles.findById(profileId);
    if (profile === null) throw new Error('PROVIDER_PROFILE_NOT_FOUND');
    return profile;
  }

  #defaultProfile(profileId: string): ProviderProfile {
    const defaults = this.#dependencies.defaults;
    return {
      baseUrl: defaults.baseUrl,
      config: { dataProcessingHints: [], lastValidatedAt: null },
      credentialLast4: null,
      credentialRef: null,
      enabled: true,
      id: profileId,
      modelId: defaults.modelId,
      modelSnapshotDate: defaults.modelSnapshotDate,
      provider: 'QWEN',
      region: 'cn-beijing',
      workspaceId: defaults.workspaceId,
    };
  }
}
