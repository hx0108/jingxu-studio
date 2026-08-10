import type { ProjectListScope } from '@jingxu/contracts';
import type { ProjectNameRef, ProjectRepository } from '@jingxu/application';
import type { Project } from '@jingxu/domain';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { syncToPromise } from '../runtime/sync-to-promise';
import { mapProjectRow, type Row } from './row-mapper';

/** projects 表的稳定列投影；不含 data_root_rel（不映射进领域聚合），不用 SELECT *。 */
const PROJECT_COLUMNS =
  'id, name, genre, style, creation_mode, dialogue_render_mode, deployment_mode, created_at, updated_at, deleted_at';

const notImplemented = (task: string): Promise<never> =>
  Promise.reject(new PersistenceRuntimeError(`NOT_IMPLEMENTED:${task}`));

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

  public listPage(): Promise<never> {
    return notImplemented('§5.2 ProjectRepository.listPage');
  }

  public scanForSearch(): Promise<never> {
    return notImplemented('§5.2 ProjectRepository.scanForSearch');
  }

  public insert(): Promise<never> {
    return notImplemented('§5.3 ProjectRepository.insert');
  }

  public update(): Promise<never> {
    return notImplemented('§5.5 ProjectRepository.update');
  }
}
