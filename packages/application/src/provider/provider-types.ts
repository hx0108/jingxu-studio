/**
 * 数据处理提示与验证时间戳：持久化为 `provider_profiles.config_json` 的有界子集。
 * `lastValidatedAt` 单一来源于此，不再在 {@link ProviderProfile} 顶层重复。
 */
export interface ProviderProfileConfig {
  readonly dataProcessingHints: readonly string[];
  readonly lastValidatedAt: string | null;
}

/**
 * Provider 档位：文本=QWEN，图片=火山方舟 Seedream，视频=火山方舟 Seedance，
 * 配音=DashScope Qwen3-TTS（与 QWEN 文本档共用同一把 DashScope Key）。
 */
export type ProviderProfileKind = 'QWEN' | 'QWEN_TTS' | 'VOLCARK_SEEDREAM' | 'VOLCARK_SEEDANCE';

export interface ProviderProfile {
  readonly baseUrl: string;
  readonly config: ProviderProfileConfig;
  readonly credentialLast4: string | null;
  /**
   * 持久化行恒为非空字符串（DB `credential_ref NOT NULL CHECK length>0`）；
   * 仅在内存默认构造、尚未落行时为 null。
   */
  readonly credentialRef: string | null;
  readonly enabled: boolean;
  readonly id: string;
  readonly modelId: string;
  readonly modelSnapshotDate: string;
  readonly provider: ProviderProfileKind;
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
  readonly provider: ProviderProfileKind;
  readonly region: 'cn-beijing';
  /** 乐观并发令牌；当前等价于 profile id（行存在即配置即凭据三者同生命周期）。 */
  readonly versionId: string;
  readonly workspaceId: string;
}

/**
 * 首次落行（`saveCredential`）所需的默认值；由 Composition Root 注入，
 * 使 `provider_profiles` 行在创建时满足全部 NOT NULL 列。
 */
export interface ProviderProfileDefaults {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly modelSnapshotDate: string;
  readonly provider: ProviderProfileKind;
  readonly workspaceId: string;
}

export interface ProviderProfileRepositoryPort {
  findById(id: string): Promise<ProviderProfile | null>;
  save(profile: ProviderProfile): Promise<void>;
  /** 删除整行——`credential_ref NOT NULL` 决定了清除凭据即销毁行。 */
  delete(id: string): Promise<void>;
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
