import type { ProjectDirectoryPort } from '@jingxu/application';

import { ProjectDirectoryAdapter } from '../project/project-directory-adapter';

export interface CreateProjectDirectoryAdapterOptions {
  /** 受管理根，与持久化运行时同一个（生产为 <LOCALAPPDATA>/JingxuStudio）。 */
  readonly managedRoot: string;
}

/**
 * Composition Root 注入点（OpenSpec §6.3）：从受管理根构造 ProjectDirectoryPort。
 *
 * 真正装配进 ProjectService/IPC 在 §7 完成；本工厂已可被 Main Composition Root 直接调用并注入，
 * 默认 WARN 写入 stderr、文件系统使用 node:fs/promises。
 */
export const createProjectDirectoryAdapter = ({
  managedRoot,
}: CreateProjectDirectoryAdapterOptions): ProjectDirectoryPort =>
  new ProjectDirectoryAdapter({ managedRoot });
