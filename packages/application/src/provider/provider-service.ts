import type { CredentialPort } from '../ports/credential';
import type { TextModelPort } from '../ports/text-model';
import type {
  ProviderProfile,
  ProviderProfileRepositoryPort,
  ProviderProfileView,
  ProviderUnitOfWorkPort,
} from './provider-types';

export interface ProviderServiceDependencies {
  readonly clock: () => string;
  readonly credentials: CredentialPort;
  readonly profiles: ProviderProfileRepositoryPort;
  readonly textModelFactory: (profile: ProviderProfile) => TextModelPort;
  readonly unitOfWork: ProviderUnitOfWorkPort;
}

const toView = (profile: ProviderProfile): ProviderProfileView => ({
  configured: profile.credentialRef !== null,
  enabled: profile.enabled,
  last4: profile.credentialLast4,
  lastValidatedAt: profile.lastValidatedAt,
  modelId: profile.modelId,
  modelSnapshotDate: profile.modelSnapshotDate,
  provider: profile.provider,
  region: profile.region,
  workspaceId: profile.workspaceId,
});

/** Provider 配置与凭据生命周期；所有返回 DTO 均不含明文 Key。 */
export class ProviderService {
  readonly #dependencies: ProviderServiceDependencies;
  public constructor(dependencies: ProviderServiceDependencies) {
    this.#dependencies = dependencies;
  }

  public async getProfile(profileId: string): Promise<ProviderProfileView | null> {
    const profile = await this.#dependencies.profiles.findById(profileId);
    return profile === null ? null : toView(profile);
  }

  public async saveCredential(profileId: string, plaintext: string): Promise<ProviderProfileView> {
    const profile = await this.#requireProfile(profileId);
    const credential = await this.#dependencies.credentials.saveCredential(plaintext);
    try {
      await this.#dependencies.unitOfWork.run(async ({ profiles }) => {
        await profiles.save({
          ...profile,
          credentialLast4: credential.last4,
          credentialRef: credential.id,
        });
      });
    } catch (error) {
      await this.#dependencies.credentials.deleteCredential(credential.id);
      throw error;
    }
    return toView({
      ...profile,
      credentialLast4: credential.last4,
      credentialRef: credential.id,
    });
  }

  public async testCredential(
    profileId: string,
  ): Promise<Awaited<ReturnType<TextModelPort['validateCredential']>>> {
    const profile = await this.#requireProfile(profileId);
    if (profile.credentialRef === null) throw new Error('PROVIDER_CREDENTIAL_MISSING');
    const result = await this.#dependencies.textModelFactory(profile).validateCredential();
    if (result.ok) {
      await this.#dependencies.unitOfWork.run(async ({ profiles }) => {
        await profiles.save({ ...profile, lastValidatedAt: this.#dependencies.clock() });
      });
    }
    return result;
  }

  public async deleteCredential(profileId: string): Promise<ProviderProfileView> {
    const profile = await this.#requireProfile(profileId);
    if (profile.credentialRef !== null) {
      await this.#dependencies.credentials.deleteCredential(profile.credentialRef);
      await this.#dependencies.unitOfWork.run(async ({ audit, profiles }) => {
        await profiles.save({
          ...profile,
          credentialLast4: null,
          credentialRef: null,
          lastValidatedAt: null,
        });
        await audit.recordCredentialDeleted(profileId, this.#dependencies.clock());
      });
    }
    return toView({
      ...profile,
      credentialLast4: null,
      credentialRef: null,
      lastValidatedAt: null,
    });
  }

  async #requireProfile(profileId: string): Promise<ProviderProfile> {
    const profile = await this.#dependencies.profiles.findById(profileId);
    if (profile === null) throw new Error('PROVIDER_PROFILE_NOT_FOUND');
    return profile;
  }
}
