import type {
  ConsentRecord,
  Episode,
  ScriptAuditEntry,
  ScriptCommandReceipt,
  ScriptDependency,
  ScriptVersion,
  StageHead,
  StagedScriptStage,
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
  find(
    projectId: string,
    episodeId: string | null,
    stage: StagedScriptStage,
  ): Promise<StageHead | null>;
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
