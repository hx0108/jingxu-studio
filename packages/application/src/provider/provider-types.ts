export interface ProviderProfile {
  readonly credentialRef: string | null;
  readonly credentialLast4: string | null;
  readonly enabled: boolean;
  readonly id: string;
  readonly lastValidatedAt: string | null;
  readonly modelId: string;
  readonly modelSnapshotDate: string;
  readonly provider: 'QWEN';
  readonly region: 'cn-beijing';
  readonly workspaceId: string;
}

export interface ProviderProfileView {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly last4: string | null;
  readonly lastValidatedAt: string | null;
  readonly modelId: string;
  readonly modelSnapshotDate: string;
  readonly provider: 'QWEN';
  readonly region: 'cn-beijing';
  readonly workspaceId: string;
}

export interface ProviderProfileRepositoryPort {
  findById(id: string): Promise<ProviderProfile | null>;
  save(profile: ProviderProfile): Promise<void>;
}

export interface ProviderAuditPort {
  recordCredentialDeleted(profileId: string, occurredAt: string): Promise<void>;
}

export interface ProviderUnitOfWorkPort {
  run<T>(
    work: (repositories: {
      readonly audit: ProviderAuditPort;
      readonly profiles: ProviderProfileRepositoryPort;
    }) => Promise<T>,
  ): Promise<T>;
}
