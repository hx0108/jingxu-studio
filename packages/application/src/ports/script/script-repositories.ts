import type { ScriptStage } from '@jingxu/contracts';

import type {
  ConsentRecord,
  Episode,
  EpisodeVersion,
  EpisodeVersionShot,
  ScriptAuditEntry,
  ScriptCommandReceipt,
  ScriptDependency,
  ScriptVersion,
  Shot,
  ShotDerivation,
  ShotContractVersion,
  ShotLockRecord,
  LockRecord,
  StageHead,
  StoryBibleVersion,
  SourceInput,
} from './script-types';
import type { FormatProfileRepository } from '../project/format-profile-repository';

export interface ProducibilityReportRecord {
  readonly id: string;
  readonly projectId: string;
  readonly episodeId: string;
  readonly episodeVersionId: string;
  readonly scope: 'EPISODE' | 'SHOT';
  readonly shotVersionId: string | null;
  readonly ruleSetVersion: 'jingxu-producibility-rules/1';
  readonly capabilitySnapshotId: string;
  readonly referencePriceSnapshotId: string | null;
  readonly status: 'PASS' | 'WARN' | 'BLOCK';
  readonly disclaimer: string;
  readonly createdAt: string;
}

export interface ProducibilityFindingRecord {
  readonly id: string;
  readonly reportId: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly severity: 'INFO' | 'WARN' | 'BLOCK';
  readonly jsonPointer: string;
  readonly observation: string;
  readonly recommendation: string;
  readonly evidenceJson: string;
  readonly sourceType: 'RULE' | 'LLM';
  readonly createdAt: string;
}

export interface FindingOverrideRecord {
  readonly id: string;
  readonly findingId: string;
  readonly decision: 'ACCEPT_RISK' | 'DISMISS';
  readonly reason: string;
  readonly actor: 'USER' | 'SYSTEM';
  readonly createdAt: string;
}

export interface ProducibilityReportSnapshot {
  readonly report: ProducibilityReportRecord;
  readonly findings: readonly ProducibilityFindingRecord[];
  readonly overrides: readonly FindingOverrideRecord[];
}

export interface ProducibilityRepositoryPort {
  insertReport(report: ProducibilityReportRecord): Promise<void>;
  insertFindings(findings: readonly ProducibilityFindingRecord[]): Promise<void>;
  insertOverride(override: FindingOverrideRecord): Promise<void>;
  findReport(id: string): Promise<ProducibilityReportSnapshot | null>;
  findFinding(id: string): Promise<Readonly<{
    readonly finding: ProducibilityFindingRecord;
    readonly report: ProducibilityReportRecord;
    readonly overrides: readonly FindingOverrideRecord[];
  }> | null>;
  findLatestCapabilitySnapshotId(): Promise<string | null>;
  findLatestReferencePriceSnapshotId(): Promise<string | null>;
}

/** Script input freezing only needs the current immutable FormatProfile snapshot. */
export type ScriptFormatProfileRepositoryPort = Pick<FormatProfileRepository, 'findCurrent'>;

export interface SourceInputRepositoryPort {
  findById(id: string): Promise<SourceInput | null>;
  findCreativeByProjectId(projectId: string): Promise<SourceInput | null>;
  readonly findLatestByProjectId?: (projectId: string) => Promise<SourceInput | null>;
  insert(sourceInput: SourceInput): Promise<void>;
}

export interface ConsentRepositoryPort {
  findDataProcessingBySourceInputId(sourceInputId: string): Promise<ConsentRecord | null>;
  insert(consent: ConsentRecord): Promise<void>;
}

export interface EpisodeRepositoryPort {
  findById(id: string): Promise<Episode | null>;
  findActiveByProjectId(projectId: string): Promise<Episode | null>;
  insert(episode: Episode): Promise<void>;
}

export interface StoryBibleVersionRepositoryPort {
  findById(id: string): Promise<StoryBibleVersion | null>;
  findMaxVersionNo(projectId: string): Promise<number>;
  listHistory(
    projectId: string,
    beforeVersionNo: number | null,
    limit: number,
  ): Promise<readonly StoryBibleVersion[]>;
  insert(version: StoryBibleVersion): Promise<void>;
}

export interface ScriptVersionRepositoryPort {
  findById(id: string): Promise<ScriptVersion | null>;
  findMaxVersionNo(
    projectId: string,
    episodeId: string | null,
    stage: ScriptVersion['stage'],
  ): Promise<number>;
  listHistory(
    projectId: string,
    episodeId: string | null,
    stage: ScriptVersion['stage'],
    beforeVersionNo: number | null,
    limit: number,
  ): Promise<readonly ScriptVersion[]>;
  insert(version: ScriptVersion): Promise<void>;
}

export interface StageHeadRepositoryPort {
  find(projectId: string, episodeId: string | null, stage: ScriptStage): Promise<StageHead | null>;
  listByProjectId(projectId: string): Promise<readonly StageHead[]>;
  upsert(head: StageHead, expectedVersionId: string | null): Promise<boolean>;
}

export interface ScriptDependencyRepositoryPort {
  listByUpstreamVersionIds(
    projectId: string,
    versionIds: readonly string[],
  ): Promise<readonly ScriptDependency[]>;
  insertMany(dependencies: readonly ScriptDependency[]): Promise<void>;
}

export interface ScriptAuditRepositoryPort {
  record(entry: ScriptAuditEntry): Promise<void>;
}

export interface ScriptCommandReceiptRepositoryPort {
  findByRequestId(requestId: string): Promise<ScriptCommandReceipt | null>;
  insert(receipt: ScriptCommandReceipt): Promise<void>;
}

export interface ScriptRepositories {
  readonly sourceInputs: SourceInputRepositoryPort;
  readonly consents: ConsentRepositoryPort;
  readonly episodes: EpisodeRepositoryPort;
  readonly storyBibleVersions: StoryBibleVersionRepositoryPort;
  readonly scriptVersions: ScriptVersionRepositoryPort;
  readonly stageHeads: StageHeadRepositoryPort;
  readonly dependencies: ScriptDependencyRepositoryPort;
  readonly audit: ScriptAuditRepositoryPort;
  readonly receipts: ScriptCommandReceiptRepositoryPort;
  readonly formatProfiles: ScriptFormatProfileRepositoryPort;
  readonly producibility?: ProducibilityRepositoryPort;
}

// ---- SHOT_CONTRACT 分镜仓储（shot-contract-generation）----

export interface EpisodeVersionRepositoryPort {
  findById(id: string): Promise<EpisodeVersion | null>;
  findMaxVersionNo(episodeId: string): Promise<number>;
  listHistory(
    episodeId: string,
    beforeVersionNo: number | null,
    limit: number,
  ): Promise<readonly EpisodeVersion[]>;
  insert(version: EpisodeVersion): Promise<void>;
  /** 读取整集快照的镜头关联（按 sequence 升序）。 */
  listShotLinks(episodeVersionId: string): Promise<readonly EpisodeVersionShot[]>;
  insertShotLinks(links: readonly EpisodeVersionShot[]): Promise<void>;
}

export interface ShotRepositoryPort {
  findById(id: string): Promise<Shot | null>;
  insertMany(shots: readonly Shot[]): Promise<void>;
  /** 确认 READY 后在同一事务推进镜头当前指针；仅此字段允许更新（updated_at 随之推进）。 */
  updateCurrentVersionIds(
    entries: readonly Readonly<{ shotId: string; currentVersionId: string; updatedAt: string }>[],
  ): Promise<void>;
  readonly updateLifecycleStatuses?: (
    entries: readonly Readonly<{
      shotId: string;
      status: Shot['lifecycleStatus'];
      updatedAt: string;
      deletedAt: string | null;
    }>[],
  ) => Promise<void>;
}

export interface ShotContractVersionRepositoryPort {
  findById(id: string): Promise<ShotContractVersion | null>;
  insertMany(versions: readonly ShotContractVersion[]): Promise<void>;
}

export interface ShotDerivationRepositoryPort {
  insertMany(values: readonly ShotDerivation[]): Promise<void>;
}

/** lock_records 读写的唯一可写事实源（TECH §9.2；locked_paths 只是投影）。 */
export interface ShotLockRepositoryPort {
  /** 有效（未解锁）锁，按 locked_at 升序；objectType 恒 SHOT_CONTRACT。 */
  listActive(projectId: string, shotId: string): Promise<readonly ShotLockRecord[]>;
  listActiveByObject(
    projectId: string,
    objectType: LockRecord['objectType'],
    objectId: string,
  ): Promise<readonly LockRecord[]>;
  insert(record: LockRecord): Promise<void>;
  /** 显式解锁置 unlocked_at；行不存在或已解锁返回 false（并发竞态由调用方收口）。 */
  unlock(id: string, unlockedAt: string): Promise<boolean>;
}

/**
 * 分镜聚合仓储。独立于 ScriptRepositories 声明；Persistence 实现与 UoW 聚合
 * 在接线 Change 步骤中将两者合并暴露给 SHOT_CONTRACT 提交事务。
 */
export interface StoryboardRepositories {
  readonly episodeVersions: EpisodeVersionRepositoryPort;
  readonly shots: ShotRepositoryPort;
  readonly shotContractVersions: ShotContractVersionRepositoryPort;
  readonly derivations?: ShotDerivationRepositoryPort;
  readonly locks: ShotLockRepositoryPort;
}
