/**
 * 受管理项目目录的不透明句柄（Design §5）。
 *
 * 只携带 projectId 与本次是否新建的标志，供 Application 决定补偿策略；绝不包含绝对路径、
 * FileHandle 或文件系统细节，避免向 Renderer 泄漏。
 */
export interface ProjectDirectoryHandle {
  readonly projectId: string;
  readonly created: boolean;
}

/** 目录补偿结果：deleted 表示本次新建的空目录已清理，否则给出跳过原因。 */
export type DirectoryCleanupOutcome =
  { readonly deleted: true } | { readonly skipped: 'NOT_CREATED' | 'NOT_EMPTY' | 'PREEXISTING' };

/**
 * 受管理项目目录 Port（Design §5、§9）。
 *
 * 只接收系统生成的 projectId，从受管理根派生路径。prepare 在事务外完成规范化、受管理
 * 根/符号链接检查、目录创建与同根临时写入/flush/delete 探测，返回不透明句柄。数据库失败
 * 时仅清理本次创建且仍为空的目录，绝不递归删除预存或非空目录，也不向 Renderer 暴露绝对
 * 路径、FileHandle 或 fs 异常。
 */
export interface ProjectDirectoryPort {
  /** 事务外准备受管理目录，返回不透明句柄。 */
  prepare(projectId: string): Promise<ProjectDirectoryHandle>;
  /** 仅当目录由本次 prepare 新建且仍为空时删除，否则跳过（Design §5）。 */
  cleanupIfCreatedEmpty(handle: ProjectDirectoryHandle): Promise<DirectoryCleanupOutcome>;
}
