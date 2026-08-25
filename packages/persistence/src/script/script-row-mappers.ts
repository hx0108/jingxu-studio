import type {
  ConsentRecord,
  Episode,
  EpisodeVersion,
  EpisodeVersionShot,
  ScriptCommandReceipt,
  ScriptDependency,
  ScriptVersion,
  Shot,
  ShotContractVersion,
  ShotDerivation,
  LockRecord,
  StageHead,
  StoryBibleVersion,
  SourceInput,
} from '@jingxu/application';

import { PersistenceRuntimeError } from '../runtime/persistence-error';
import type { SqliteOutputValue } from '../runtime/sqlite-database';

export type ScriptRow = Readonly<Record<string, SqliteOutputValue>>;
const invalid = (): never => {
  throw new PersistenceRuntimeError('SCRIPT_ROW_INVALID');
};
const text = (row: ScriptRow, key: string): string => {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : invalid();
};
const nullableText = (row: ScriptRow, key: string): string | null => {
  const value = row[key];
  return value === null ? null : typeof value === 'string' ? value : invalid();
};
const number = (row: ScriptRow, key: string): number => {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : invalid();
};
const jsonObject = (value: string): Readonly<Record<string, string | number | boolean | null>> => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (
        Object.values(record).every(
          (item) => item === null || ['string', 'number', 'boolean'].includes(typeof item),
        )
      ) {
        return record as Readonly<Record<string, string | number | boolean | null>>;
      }
    }
  } catch {
    // Normalize malformed or unsafe JSON at the persistence boundary.
  }
  return invalid();
};

export const mapSourceInput = (row: ScriptRow): SourceInput => {
  const content = text(row, 'content_text');
  const charCount = number(row, 'char_count');
  const sha256 = text(row, 'sha256');
  const inputKind = text(row, 'input_kind');
  if (
    !['CREATIVE', 'TXT', 'MARKDOWN'].includes(inputKind) ||
    charCount < (inputKind === 'CREATIVE' ? 20 : 1) ||
    charCount > (inputKind === 'CREATIVE' ? 2_000 : 30_000) ||
    content.trim().length === 0 ||
    Array.from(content).length !== charCount ||
    createHash('sha256').update(content, 'utf8').digest('hex') !== sha256
  ) {
    return invalid();
  }
  return {
    charCount,
    content,
    createdAt: text(row, 'created_at'),
    encoding: nullableText(row, 'encoding') as SourceInput['encoding'],
    fileName: nullableText(row, 'file_name'),
    id: text(row, 'id'),
    inputKind: inputKind as SourceInput['inputKind'],
    projectId: text(row, 'project_id'),
    sha256,
  };
};
export const mapConsent = (row: ScriptRow): ConsentRecord => ({
  id: text(row, 'id'),
  projectId: text(row, 'project_id'),
  sourceInputId: text(row, 'source_input_id'),
  consentType: text(row, 'consent_type') as 'DATA_PROCESSING',
  contentSource: text(row, 'content_source') as 'SELF_OWNED',
  scope: text(row, 'scope') as 'SOURCE_INPUT',
  statement: text(row, 'statement_text'),
  confirmedAt: text(row, 'confirmed_at'),
  revokedAt: nullableText(row, 'revoked_at'),
});
export const mapEpisode = (row: ScriptRow): Episode => ({
  id: text(row, 'id'),
  projectId: text(row, 'project_id'),
  title: text(row, 'title'),
  targetDurationSec: number(row, 'target_duration_sec'),
  currentVersionId: nullableText(row, 'current_version_id'),
  createdAt: text(row, 'created_at'),
  updatedAt: text(row, 'updated_at'),
  deletedAt: nullableText(row, 'deleted_at'),
});
export const mapStoryBibleVersion = (row: ScriptRow): StoryBibleVersion => ({
  id: text(row, 'id'),
  projectId: text(row, 'project_id'),
  versionNo: number(row, 'version_no'),
  parentId: nullableText(row, 'parent_id'),
  document: text(row, 'document_json'),
  documentSha256: text(row, 'document_sha256'),
  status: text(row, 'status') as StoryBibleVersion['status'],
  source: text(row, 'source') as StoryBibleVersion['source'],
  sourceInvocationId: nullableText(row, 'source_invocation_id'),
  createdAt: text(row, 'created_at'),
});
export const mapScriptVersion = (row: ScriptRow): ScriptVersion => ({
  id: text(row, 'id'),
  projectId: text(row, 'project_id'),
  episodeId: nullableText(row, 'episode_id'),
  stage: text(row, 'stage') as ScriptVersion['stage'],
  versionNo: number(row, 'version_no'),
  parentId: nullableText(row, 'parent_id'),
  sourceInputId: nullableText(row, 'source_input_id'),
  document: text(row, 'document_json'),
  documentSha256: text(row, 'document_sha256'),
  status: text(row, 'status') as ScriptVersion['status'],
  changeSummary: nullableText(row, 'change_summary'),
  source: text(row, 'source') as ScriptVersion['source'],
  sourceInvocationId: nullableText(row, 'source_invocation_id'),
  createdAt: text(row, 'created_at'),
});
export const mapStageHead = (row: ScriptRow): StageHead => ({
  projectId: text(row, 'project_id'),
  episodeId: nullableText(row, 'episode_id'),
  stage: text(row, 'stage') as StageHead['stage'],
  currentVersionType: text(row, 'current_version_type') as StageHead['currentVersionType'],
  currentVersionId: text(row, 'current_version_id'),
  updatedAt: text(row, 'updated_at'),
});
export const mapEpisodeVersion = (row: ScriptRow): EpisodeVersion => ({
  id: text(row, 'id'),
  episodeId: text(row, 'episode_id'),
  versionNo: number(row, 'version_no'),
  parentId: nullableText(row, 'parent_id'),
  storyBibleVersionId: text(row, 'story_bible_version_id'),
  formatProfileId: text(row, 'format_profile_id'),
  targetDurationSec: number(row, 'target_duration_sec'),
  shotSetHash: text(row, 'shot_set_hash'),
  status: text(row, 'status') as EpisodeVersion['status'],
  createdAt: text(row, 'created_at'),
});
export const mapShot = (row: ScriptRow): Shot => ({
  id: text(row, 'id'),
  episodeId: text(row, 'episode_id'),
  lifecycleStatus: text(row, 'lifecycle_status') as Shot['lifecycleStatus'],
  currentVersionId: nullableText(row, 'current_version_id'),
  createdAt: text(row, 'created_at'),
  updatedAt: text(row, 'updated_at'),
  deletedAt: nullableText(row, 'deleted_at'),
});
export const mapShotDerivation = (row: ScriptRow): ShotDerivation => ({
  newShotId: text(row, 'new_shot_id'),
  sourceShotId: text(row, 'source_shot_id'),
  operation: text(row, 'operation') as ShotDerivation['operation'],
  createdAt: text(row, 'created_at'),
});
export const mapShotContractVersion = (row: ScriptRow): ShotContractVersion => ({
  id: text(row, 'id'),
  shotId: text(row, 'shot_id'),
  versionNo: number(row, 'version_no'),
  parentId: nullableText(row, 'parent_id'),
  externalParentVersionId: nullableText(row, 'external_parent_version_id'),
  lineageResolutionStatus: text(
    row,
    'lineage_resolution_status',
  ) as ShotContractVersion['lineageResolutionStatus'],
  sequence: number(row, 'sequence'),
  versionStatus: text(row, 'version_status') as ShotContractVersion['versionStatus'],
  formatProfileId: text(row, 'format_profile_id'),
  targetDurationSec: number(row, 'target_duration_sec'),
  dialogueRenderMode: text(
    row,
    'dialogue_render_mode',
  ) as ShotContractVersion['dialogueRenderMode'],
  document: text(row, 'document_json'),
  documentSha256: text(row, 'document_sha256'),
  sourceInvocationId: nullableText(row, 'source_invocation_id'),
  createdAt: text(row, 'created_at'),
});
export const mapEpisodeVersionShot = (row: ScriptRow): EpisodeVersionShot => ({
  episodeVersionId: text(row, 'episode_version_id'),
  shotId: text(row, 'shot_id'),
  shotVersionId: text(row, 'shot_version_id'),
  sequence: number(row, 'sequence'),
});
export const mapLockRecord = (row: ScriptRow): LockRecord => {
  const lockedBy = text(row, 'locked_by');
  if (lockedBy !== 'USER' && lockedBy !== 'SYSTEM') return invalid();
  const objectType = text(row, 'object_type');
  if (
    objectType !== 'STORY_BIBLE' &&
    objectType !== 'SCRIPT_VERSION' &&
    objectType !== 'SHOT_CONTRACT' &&
    objectType !== 'EPISODE_VERSION'
  )
    return invalid();
  return {
    id: text(row, 'id'),
    jsonPointer: text(row, 'json_pointer'),
    lockedAt: text(row, 'locked_at'),
    lockedBy,
    note: nullableText(row, 'note'),
    objectId: text(row, 'object_id'),
    objectType,
    objectVersionId: text(row, 'object_version_id'),
    projectId: text(row, 'project_id'),
    unlockedAt: nullableText(row, 'unlocked_at'),
  };
};
export const mapDependency = (row: ScriptRow): ScriptDependency => ({
  id: text(row, 'id'),
  projectId: text(row, 'project_id'),
  upstreamType: text(row, 'upstream_type') as ScriptDependency['upstreamType'],
  upstreamId: text(row, 'upstream_id'),
  upstreamVersionId: text(row, 'upstream_version_id'),
  downstreamType: text(row, 'downstream_type') as ScriptDependency['downstreamType'],
  downstreamId: text(row, 'downstream_id'),
  downstreamVersionId: text(row, 'downstream_version_id'),
  dependencyType: text(row, 'dependency_type') as ScriptDependency['dependencyType'],
  createdAt: text(row, 'created_at'),
});
export const mapReceipt = (row: ScriptRow): ScriptCommandReceipt => ({
  requestId: text(row, 'request_id'),
  commandName: text(row, 'command_name') as ScriptCommandReceipt['commandName'],
  payloadSha256: text(row, 'payload_sha256'),
  projectId: text(row, 'project_id'),
  resultRef: jsonObject(text(row, 'result_ref_json')),
  traceId: text(row, 'trace_id'),
  committedAt: text(row, 'committed_at'),
});
import { createHash } from 'node:crypto';
