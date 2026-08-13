import type { FormatProfileRepository } from '@jingxu/application';
import type { FormatProfile } from '@jingxu/domain';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { syncToPromise } from '../runtime/sync-to-promise';
import { mapFormatProfileRow, type Row } from './row-mapper';

/** format_profiles 表的稳定列投影；不用 SELECT *。 */
const FORMAT_PROFILE_COLUMNS =
  'id, project_id, version_no, parent_id, aspect_ratio, width, height, fps, language, subtitle_safe_area_json, is_current, created_at';

/**
 * FormatProfile 版本链的 SQLite 实现（Design §6）。
 *
 * node:sqlite 为同步 API；方法经 {@link syncToPromise} 桥接，使坏数据归一化抛出的
 * {@link PersistenceRuntimeError} 以 rejection 传播（Port 契约），又不使用 async 关键字。
 * 所有方法在 {@link ProjectUnitOfWorkPort} 事务内调用，不自行提交。
 */
export class SqliteFormatProfileRepository implements FormatProfileRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public findCurrent(projectId: string): Promise<FormatProfile | null> {
    return syncToPromise(() => {
      const rows = this.database
        .prepare(
          `SELECT ${FORMAT_PROFILE_COLUMNS} FROM format_profiles WHERE project_id = ? AND is_current = 1`,
        )
        .all(projectId) as Row[];
      if (rows.length === 0) return null;
      // ux_format_profile_current 部分唯一索引正常保证唯一；多于一行表示库损坏。
      if (rows.length > 1) {
        throw new PersistenceRuntimeError('FORMAT_PROFILE_MULTIPLE_CURRENT');
      }
      const first = rows[0];
      return first === undefined ? null : mapFormatProfileRow(first);
    });
  }

  public findAllByProject(projectId: string): Promise<readonly FormatProfile[]> {
    return syncToPromise(() => {
      const rows = this.database
        .prepare(
          `SELECT ${FORMAT_PROFILE_COLUMNS} FROM format_profiles WHERE project_id = ? ORDER BY version_no ASC`,
        )
        .all(projectId) as Row[];
      return rows.map((row) => mapFormatProfileRow(row));
    });
  }

  public findMaxVersionNo(projectId: string): Promise<number> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          'SELECT COALESCE(MAX(version_no), 0) AS max_version_no FROM format_profiles WHERE project_id = ?',
        )
        .get(projectId) as Row | undefined;
      const value = row?.max_version_no;
      return typeof value === 'number' ? value : 0;
    });
  }

  public isCurrentReferencedByShotContract(
    projectId: string,
    formatProfileId: string,
  ): Promise<boolean> {
    return syncToPromise(
      () =>
        this.database
          .prepare(
            `SELECT 1 AS found
             FROM shot_contract_versions scv
             INNER JOIN format_profiles fp ON fp.id = scv.format_profile_id
             WHERE fp.project_id = ? AND scv.format_profile_id = ?
             LIMIT 1`,
          )
          .get(projectId, formatProfileId) !== undefined,
    );
  }

  public insert(profile: FormatProfile): Promise<void> {
    return syncToPromise(() => {
      this.database
        .prepare(
          `INSERT INTO format_profiles (
            id, project_id, version_no, parent_id, aspect_ratio, width, height, fps,
            language, subtitle_safe_area_json, is_current, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          profile.id,
          profile.projectId,
          profile.versionNo,
          profile.parentId,
          profile.spec.aspectRatio,
          profile.spec.width,
          profile.spec.height,
          profile.spec.fps,
          profile.spec.language,
          JSON.stringify(profile.spec.subtitleSafeArea),
          profile.isCurrent ? 1 : 0,
          profile.createdAt,
        );
    });
  }

  public unsetCurrent(projectId: string, formatProfileId: string): Promise<void> {
    return syncToPromise(() => {
      const result = this.database
        .prepare(
          `UPDATE format_profiles
           SET is_current = 0
           WHERE project_id = ? AND id = ? AND is_current = 1`,
        )
        .run(projectId, formatProfileId) as { readonly changes?: number };
      if (result.changes !== 1) {
        throw new PersistenceRuntimeError('FORMAT_PROFILE_CURRENT_NOT_FOUND');
      }
    });
  }
}
