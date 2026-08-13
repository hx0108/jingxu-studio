import type {
  ProjectListPage,
  ProjectListQuery,
  ProjectNameRef,
  ProjectRepository,
  ProjectSearchScan,
  ProjectSearchScanQuery,
} from '@jingxu/application';
import type { Project } from '@jingxu/domain';
import type { ProjectListScope } from '@jingxu/contracts';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { syncToPromise } from '../runtime/sync-to-promise';
import { mapProjectListItemRow, mapProjectRow, type Row } from './row-mapper';

/** projects 表的稳定列投影；不含 data_root_rel（不映射进领域聚合），不用 SELECT *。 */
const PROJECT_COLUMNS =
  'id, name, genre, style, creation_mode, dialogue_render_mode, deployment_mode, created_at, updated_at, deleted_at';

/** list/scan 查询带表别名的前缀列投影（JOIN 后 id 等列名歧义，必须显式 p.）。 */
const PROJECT_LIST_COLUMNS =
  'p.id, p.name, p.genre, p.style, p.creation_mode, p.dialogue_render_mode, p.deployment_mode, p.created_at, p.updated_at, p.deleted_at';

/** keyset 定位点之后的筛选子句（同 updated_at 用 id DESC 做 tie-break，不用 OFFSET）。 */
const KEYSET_AFTER_CLAUSE = ' AND (p.updated_at < ? OR (p.updated_at = ? AND p.id < ?))';

/**
 * Project 聚合的 SQLite 实现（Design §1、§6、§7）。
 *
 * node:sqlite 为同步 API；方法经 {@link syncToPromise} 桥接，使行映射/坏数据归一化抛出的
 * {@link PersistenceRuntimeError} 以 rejection 传播（Port 契约），又不使用 async 关键字
 * （避免 require-await）。所有方法在 {@link ProjectUnitOfWorkPort} 的事务内调用，
 * Repository 不自行提交或回滚，不向 Application 返回 Row、Statement 或连接。
 */
export class SqliteProjectRepository implements ProjectRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public findById(id: string, scope: ProjectListScope): Promise<Project | null> {
    return syncToPromise(() => {
      const scopeFilter = scope === 'ACTIVE' ? 'deleted_at IS NULL' : 'deleted_at IS NOT NULL';
      const row = this.database
        .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ? AND ${scopeFilter}`)
        .get(id) as Row | undefined;
      return row === undefined ? null : mapProjectRow(row);
    });
  }

  public findActiveNameRefs(excludeProjectId: string | null): Promise<readonly ProjectNameRef[]> {
    return syncToPromise(() => {
      const rows =
        excludeProjectId === null
          ? (this.database
              .prepare('SELECT id, name FROM projects WHERE deleted_at IS NULL')
              .all() as Row[])
          : (this.database
              .prepare('SELECT id, name FROM projects WHERE deleted_at IS NULL AND id <> ?')
              .all(excludeProjectId) as Row[]);
      return rows.map((row): ProjectNameRef => ({
        projectId: row.id as string,
        name: row.name as string,
      }));
    });
  }

  public listPage(query: ProjectListQuery): Promise<ProjectListPage> {
    return syncToPromise(() => {
      const scopeFilter =
        query.scope === 'ACTIVE' ? 'p.deleted_at IS NULL' : 'p.deleted_at IS NOT NULL';
      const sql = `SELECT ${PROJECT_LIST_COLUMNS}, fp.aspect_ratio AS current_aspect_ratio FROM projects p LEFT JOIN format_profiles fp ON fp.project_id = p.id AND fp.is_current = 1 WHERE ${scopeFilter}${
        query.after === null ? '' : KEYSET_AFTER_CLAUSE
      } ORDER BY p.updated_at DESC, p.id DESC LIMIT ?`;
      // 多取 1 条判断是否还有下一页，避免用 OFFSET；多余那条丢弃，不进入 items/nextAfter。
      const rows =
        query.after === null
          ? (this.database.prepare(sql).all(query.limit + 1) as Row[])
          : (this.database
              .prepare(sql)
              .all(
                query.after.updatedAt,
                query.after.updatedAt,
                query.after.id,
                query.limit + 1,
              ) as Row[]);
      const truncated = rows.length > query.limit;
      const page = truncated ? rows.slice(0, query.limit) : rows;
      const items = page.map(mapProjectListItemRow);
      const lastRow = page[page.length - 1];
      const nextAfter =
        truncated && lastRow !== undefined
          ? { updatedAt: lastRow.updated_at as string, id: lastRow.id as string }
          : null;
      return { items, nextAfter, truncated };
    });
  }

  public scanForSearch(query: ProjectSearchScanQuery): Promise<ProjectSearchScan> {
    return syncToPromise(() => {
      const scopeFilter =
        query.scope === 'ACTIVE' ? 'p.deleted_at IS NULL' : 'p.deleted_at IS NOT NULL';
      const sql = `SELECT ${PROJECT_LIST_COLUMNS}, fp.aspect_ratio AS current_aspect_ratio FROM projects p LEFT JOIN format_profiles fp ON fp.project_id = p.id AND fp.is_current = 1 WHERE ${scopeFilter}${
        query.after === null ? '' : KEYSET_AFTER_CLAUSE
      } ORDER BY p.updated_at DESC, p.id DESC LIMIT ?`;
      // 多取 1 条判断是否触及硬上限，避免把“恰好 hardLimit 条且无更多”误判为截断。
      const rows =
        query.after === null
          ? (this.database.prepare(sql).all(query.hardLimit + 1) as Row[])
          : (this.database
              .prepare(sql)
              .all(
                query.after.updatedAt,
                query.after.updatedAt,
                query.after.id,
                query.hardLimit + 1,
              ) as Row[]);
      const truncated = rows.length > query.hardLimit;
      return {
        candidates: rows.slice(0, query.hardLimit).map(mapProjectListItemRow),
        truncated,
      };
    });
  }

  public insert(project: Project): Promise<void> {
    return syncToPromise(() => {
      this.database
        .prepare(
          `INSERT INTO projects (
            id, name, genre, style, creation_mode, dialogue_render_mode, deployment_mode,
            data_root_rel, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          project.id,
          project.name,
          project.genre,
          project.style,
          project.creationMode,
          project.dialogueRenderMode,
          project.deploymentMode,
          `projects/${project.id}`,
          project.createdAt,
          project.updatedAt,
          project.deletedAt,
        );
    });
  }

  public update(project: Project, expectedUpdatedAt: string): Promise<boolean> {
    return syncToPromise(() => {
      const result = this.database
        .prepare(
          `UPDATE projects
           SET name = ?, genre = ?, style = ?, creation_mode = ?, dialogue_render_mode = ?,
               deployment_mode = ?, updated_at = ?, deleted_at = ?
           WHERE id = ? AND updated_at = ?`,
        )
        .run(
          project.name,
          project.genre,
          project.style,
          project.creationMode,
          project.dialogueRenderMode,
          project.deploymentMode,
          project.updatedAt,
          project.deletedAt,
          project.id,
          expectedUpdatedAt,
        ) as { readonly changes?: number };
      return result.changes === 1;
    });
  }
}
