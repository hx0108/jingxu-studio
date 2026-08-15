import type { ScriptStage } from '@jingxu/contracts';

export type StagedScriptStage = Exclude<ScriptStage, 'SHOT_CONTRACT'>;
export type ScriptVersionStatus = 'DRAFT' | 'READY' | 'STALE_INPUT';
export type ScriptVersionSource = 'AI' | 'USER' | 'IMPORT' | 'SYSTEM_INVALIDATION';

export interface SourceInput {
  readonly id: string;
  readonly projectId: string;
  readonly inputKind: 'CREATIVE';
  readonly fileName: null;
  readonly encoding: null;
  /** Exact user-supplied string. Application and adapters must not trim or truncate it. */
  readonly content: string;
  readonly charCount: number;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface ConsentRecord {
  readonly id: string;
  readonly projectId: string;
  readonly sourceInputId: string;
  readonly consentType: 'DATA_PROCESSING';
  readonly contentSource: 'SELF_OWNED';
  readonly scope: 'SOURCE_INPUT';
  readonly statement: string;
  readonly confirmedAt: string;
  readonly revokedAt: string | null;
}

export interface Episode {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly targetDurationSec: number;
  readonly currentVersionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface StoryBibleVersion {
  readonly id: string;
  readonly projectId: string;
  readonly versionNo: number;
  readonly parentId: string | null;
  readonly document: string;
  readonly documentSha256: string;
  readonly status: ScriptVersionStatus;
  readonly source: ScriptVersionSource;
  readonly sourceInvocationId: string | null;
  readonly createdAt: string;
}

export interface ScriptVersion {
  readonly id: string;
  readonly projectId: string;
  readonly episodeId: string | null;
  readonly stage: Exclude<StagedScriptStage, 'STORY_BIBLE'>;
  readonly versionNo: number;
  readonly parentId: string | null;
  readonly sourceInputId: string | null;
  readonly document: string;
  readonly documentSha256: string;
  readonly status: ScriptVersionStatus;
  readonly changeSummary: string | null;
  readonly source: ScriptVersionSource;
  readonly sourceInvocationId: string | null;
  readonly createdAt: string;
}

export type StageVersionType = 'STORY_BIBLE_VERSION' | 'SCRIPT_VERSION' | 'EPISODE_VERSION';

export interface StageHead {
  readonly projectId: string;
  readonly episodeId: string | null;
  /** SHOT_CONTRACT 阶段 head 指向整集分镜版本（EPISODE_VERSION）。 */
  readonly stage: ScriptStage;
  readonly currentVersionType: StageVersionType;
  readonly currentVersionId: string;
  readonly updatedAt: string;
}

export type ScriptDependencyType = 'GENERATED_FROM' | 'REFERENCES' | 'INVALIDATES';

export interface ScriptDependency {
  readonly id: string;
  readonly projectId: string;
  readonly upstreamType: 'SOURCE_INPUT' | StageVersionType;
  readonly upstreamId: string;
  readonly upstreamVersionId: string;
  readonly downstreamType: StageVersionType;
  readonly downstreamId: string;
  readonly downstreamVersionId: string;
  readonly dependencyType: ScriptDependencyType;
  readonly createdAt: string;
}

export interface ScriptAuditEntry {
  readonly id: string;
  readonly projectId: string;
  readonly actor: 'USER' | 'SYSTEM' | 'AI';
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly objectVersionId: string | null;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  /** Structured, allowlisted metadata. It must not contain source content, prompts, or responses. */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly traceId: string;
  readonly createdAt: string;
}

export type ScriptCommandName =
  'INITIALIZE_ORIGINAL' | 'SAVE_SCRIPT_DRAFT' | 'CONFIRM_SCRIPT_VERSION' | 'RESTORE_SCRIPT_VERSION';

export interface ScriptCommandReceipt {
  readonly requestId: string;
  readonly commandName: ScriptCommandName;
  readonly payloadSha256: string;
  readonly projectId: string;
  readonly resultRef: Readonly<Record<string, string | number | boolean | null>>;
  readonly traceId: string;
  readonly committedAt: string;
}

export interface ScriptVersionSummary {
  readonly id: string;
  readonly versionNo: number;
  readonly status: ScriptVersionStatus;
  readonly source: ScriptVersionSource;
  readonly parentId: string | null;
  readonly createdAt: string;
}

export interface ScriptStageWorkspace {
  readonly stage: StagedScriptStage;
  readonly episodeId: string | null;
  readonly head: StageHead | null;
  readonly current: StoryBibleVersion | ScriptVersion | null;
  readonly history: readonly ScriptVersionSummary[];
  readonly historyTruncated: boolean;
}

export interface ScriptWorkspaceSnapshot {
  readonly projectId: string;
  readonly sourceInput: SourceInput | null;
  readonly episode: Episode | null;
  readonly stages: readonly ScriptStageWorkspace[];
}

export interface ScriptVersionDocument {
  readonly versionId: string;
  readonly stage: StagedScriptStage;
  readonly document: string;
  readonly documentSha256: string;
}

// ---- SHOT_CONTRACT 分镜（shot-contract-generation）----

export type ShotLifecycleStatus = 'ACTIVE' | 'SUPERSEDED' | 'DELETED';
export type ShotLineageResolutionStatus = 'ROOT' | 'LOCAL_VERIFIED' | 'EXTERNAL_UNRESOLVED';
export type DialogueRenderMode =
  'NARRATION_FIRST' | 'WEAK_LIP_SYNC' | 'PRECISE_LIP_SYNC' | 'SUBTITLE_ONLY';

/** SHOT_CONTRACT 阶段的产物单位：整集分镜版本（0001 episode_versions 行）。 */
export interface EpisodeVersion {
  readonly id: string;
  readonly episodeId: string;
  readonly versionNo: number;
  readonly parentId: string | null;
  readonly storyBibleVersionId: string;
  readonly formatProfileId: string;
  readonly targetDurationSec: number;
  readonly shotSetHash: string;
  readonly status: ScriptVersionStatus;
  readonly createdAt: string;
}

/** 镜头实体；生命周期行无不可变触发器，currentVersionId 由确认事务受控推进。 */
export interface Shot {
  readonly id: string;
  readonly episodeId: string;
  readonly lifecycleStatus: ShotLifecycleStatus;
  readonly currentVersionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/** 不可变镜头契约版本（0001 shot_contract_versions 行；document 为 ShotContract 1.1.0）。 */
export interface ShotContractVersion {
  readonly id: string;
  readonly shotId: string;
  readonly versionNo: number;
  readonly parentId: string | null;
  readonly externalParentVersionId: string | null;
  readonly lineageResolutionStatus: ShotLineageResolutionStatus;
  readonly sequence: number;
  readonly versionStatus: ScriptVersionStatus;
  readonly formatProfileId: string;
  readonly targetDurationSec: number;
  readonly dialogueRenderMode: DialogueRenderMode;
  readonly document: string;
  readonly documentSha256: string;
  readonly sourceInvocationId: string | null;
  readonly createdAt: string;
}

/** episode_version 与镜头版本的集合快照关联（0001 episode_version_shots 行）。 */
export interface EpisodeVersionShot {
  readonly episodeVersionId: string;
  readonly shotId: string;
  readonly shotVersionId: string;
  readonly sequence: number;
}
