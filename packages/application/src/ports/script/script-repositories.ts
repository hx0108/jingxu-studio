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
  ShotContractVersion,
  ShotLockRecord,
  StageHead,
  StoryBibleVersion,
  SourceInput,
} from './script-types';
import type { FormatProfileRepository } from '../project/format-profile-repository';

/** Script input freezing only needs the current immutable FormatProfile snapshot. */
export type ScriptFormatProfileRepositoryPort = Pick<FormatProfileRepository, 'findCurrent'>;

export interface SourceInputRepositoryPort {
  findById(id: string): Promise<SourceInput | null>;
  findCreativeByProjectId(projectId: string): Promise<SourceInput | null>;
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
}

export interface ShotContractVersionRepositoryPort {
  findById(id: string): Promise<ShotContractVersion | null>;
  insertMany(versions: readonly ShotContractVersion[]): Promise<void>;
}

/** lock_records 读写的唯一可写事实源（TECH §9.2；locked_paths 只是投影）。 */
export interface ShotLockRepositoryPort {
  /** 有效（未解锁）锁，按 locked_at 升序；objectType 恒 SHOT_CONTRACT。 */
  listActive(projectId: string, shotId: string): Promise<readonly ShotLockRecord[]>;
  insert(record: ShotLockRecord): Promise<void>;
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
  readonly locks: ShotLockRepositoryPort;
}
