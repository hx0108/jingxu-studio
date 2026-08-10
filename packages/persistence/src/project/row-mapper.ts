import type {
  AspectRatio,
  CreationMode,
  DeploymentMode,
  DialogueRenderMode,
  FormatProfile,
  FormatProfileSpec,
  Project,
  SubtitleSafeArea,
  SubtitleSafeAreaField,
} from '@jingxu/domain';
import { SUBTITLE_SAFE_AREA_MAX, SUBTITLE_SAFE_AREA_MIN } from '@jingxu/domain';

import type { SqliteOutputValue } from '../runtime/sqlite-database';
import { PersistenceRuntimeError } from '../runtime/persistence-error';

/**
 * SQLite Row 的 Repository 内部视图（Design §1：Row/Statement/连接不离开 persistence 包）。
 *
 * node:sqlite 返回 `Record<string, SqliteOutputValue>`；本类型仅供 row-mapper 与
 * Repository 实现内部使用，绝不向 Application 暴露。
 */
export type Row = Readonly<Record<string, SqliteOutputValue>>;

const PROJECT_ROW_CORRUPT = 'PROJECT_ROW_CORRUPT';
const FORMAT_PROFILE_ROW_CORRUPT = 'FORMAT_PROFILE_ROW_CORRUPT';

const requiredString = (row: Row, column: string): string => {
  const value = row[column];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PersistenceRuntimeError(PROJECT_ROW_CORRUPT);
  }
  return value;
};

const nullableString = (row: Row, column: string): string | null => {
  const value = row[column];
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new PersistenceRuntimeError(PROJECT_ROW_CORRUPT);
};

const requiredNumber = (row: Row, column: string): number => {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PersistenceRuntimeError(FORMAT_PROFILE_ROW_CORRUPT);
  }
  return value;
};

const requiredBoolean = (row: Row, column: string): boolean => {
  const value = row[column];
  if (value === 0) return false;
  if (value === 1) return true;
  throw new PersistenceRuntimeError(FORMAT_PROFILE_ROW_CORRUPT);
};

/** 读取并校验单个安全区百分比（0–30 的有限数）。 */
const readSafeAreaValue = (
  record: Record<string, unknown>,
  field: SubtitleSafeAreaField,
): number => {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PersistenceRuntimeError(FORMAT_PROFILE_ROW_CORRUPT);
  }
  if (value < SUBTITLE_SAFE_AREA_MIN || value > SUBTITLE_SAFE_AREA_MAX) {
    throw new PersistenceRuntimeError(FORMAT_PROFILE_ROW_CORRUPT);
  }
  return value;
};

const parseSubtitleSafeArea = (json: SqliteOutputValue | undefined): SubtitleSafeArea => {
  if (typeof json !== 'string') {
    throw new PersistenceRuntimeError(FORMAT_PROFILE_ROW_CORRUPT);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PersistenceRuntimeError(FORMAT_PROFILE_ROW_CORRUPT);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PersistenceRuntimeError(FORMAT_PROFILE_ROW_CORRUPT);
  }
  const record = parsed as Record<string, unknown>;
  return {
    top: readSafeAreaValue(record, 'top'),
    right: readSafeAreaValue(record, 'right'),
    bottom: readSafeAreaValue(record, 'bottom'),
    left: readSafeAreaValue(record, 'left'),
  };
};

/**
 * 把 projects 行映射为 {@link Project} 聚合。
 *
 * 忽略 `data_root_rel`（持久化细节，不进入领域聚合）。creationMode 等枚举由
 * `0001_initial.sql` 的 CHECK 约束保证合法，此处直接断言为联合类型。
 */
export const mapProjectRow = (row: Row): Project => ({
  id: requiredString(row, 'id'),
  name: requiredString(row, 'name'),
  genre: nullableString(row, 'genre'),
  style: nullableString(row, 'style'),
  creationMode: requiredString(row, 'creation_mode') as CreationMode,
  dialogueRenderMode: requiredString(row, 'dialogue_render_mode') as DialogueRenderMode,
  deploymentMode: requiredString(row, 'deployment_mode') as DeploymentMode,
  createdAt: requiredString(row, 'created_at'),
  updatedAt: requiredString(row, 'updated_at'),
  deletedAt: nullableString(row, 'deleted_at'),
});

/**
 * 把 format_profiles 行映射为 {@link FormatProfile} 聚合。
 *
 * `subtitle_safe_area_json` 解析并校验四边为 0–30 的有限数；坏 JSON 或越界值归一化为
 * {@link PersistenceRuntimeError}，由 Application 在事务边界 catch 为
 * `PROJECT_PERSISTENCE_FAILED`，绝不把原始 Row/JSON 暴露给 Renderer。
 */
export const mapFormatProfileRow = (row: Row): FormatProfile => {
  const spec: FormatProfileSpec = {
    aspectRatio: requiredString(row, 'aspect_ratio') as AspectRatio,
    width: requiredNumber(row, 'width'),
    height: requiredNumber(row, 'height'),
    fps: requiredNumber(row, 'fps'),
    language: requiredString(row, 'language'),
    subtitleSafeArea: parseSubtitleSafeArea(row.subtitle_safe_area_json),
  };
  return {
    id: requiredString(row, 'id'),
    projectId: requiredString(row, 'project_id'),
    versionNo: requiredNumber(row, 'version_no'),
    parentId: nullableString(row, 'parent_id'),
    spec,
    isCurrent: requiredBoolean(row, 'is_current'),
    createdAt: requiredString(row, 'created_at'),
  };
};
