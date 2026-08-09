import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import type {
  DirectoryCleanupOutcome,
  ProjectDirectoryHandle,
  ProjectDirectoryPort,
} from '@jingxu/application';

/**
 * 受管理项目目录的 Main 进程 Adapter（OpenSpec change
 * project-format-profile-management §6；Design §5、§9）。
 *
 * 只接收系统生成的 projectId，从受管理根派生 `<managedRoot>/projects/<project_id>`，所有
 * 文件 I/O 在 SQLite 事务外完成。绝不向调用方暴露绝对路径、FileHandle 或原始 fs 异常：
 * 成功返回只含 projectId/created 的不透明句柄，失败抛出稳定 code 的 ProjectDirectoryError
 *（由 Application 归一化为 PROJECT_DIRECTORY_UNAVAILABLE）。
 *
 * filesystem 注入仅为让写入/flush/delete 与 rmdir 的失败路径在测试中确定复现——跨平台权限
 * 语义不可靠（Design §5 风险：目录与 SQLite 无同一 ACID）。生产默认指向 node:fs/promises，
 * 行为与真实 I/O 完全一致。
 */

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{12,64}$/u;
const PROJECTS_SEGMENT = 'projects';
const PROBE_PREFIX = '.jingxu-write-probe-';

/** Adapter 抛出的稳定错误：只携带 code，绝不包含路径或 fs 细节。 */
export class ProjectDirectoryError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.name = 'ProjectDirectoryError';
    this.code = code;
  }
}

/** 受限的 stat 结果：只需判断是否目录。 */
export interface ProjectDirectoryStats {
  isDirectory(): boolean;
}

/** 受限的 FileHandle：探测用到的写入/flush/关闭。 */
export interface ProjectDirectoryFileHandle {
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Adapter 依赖的文件系统子集。默认实现指向 node:fs/promises；测试注入失败版以确定复现
 * 写入/flush/delete 与 rmdir 失败（Design §5）。
 */
export interface ProjectDirectoryFilesystem {
  mkdir(path: string, options: { readonly recursive: true }): Promise<void>;
  stat(path: string): Promise<ProjectDirectoryStats>;
  realpath(path: string): Promise<string>;
  open(path: string, flags: 'wx'): Promise<ProjectDirectoryFileHandle>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  readdir(path: string): Promise<readonly string[]>;
}

/** 脱敏 WARN 输出：只允许 projectId/operation/outcome/reason，禁止记录路径。 */
export type ProjectDirectoryWarnSink = (message: string) => void;

export interface ProjectDirectoryAdapterOptions {
  /** 受管理根，与持久化运行时同一个（生产为 <LOCALAPPDATA>/JingxuStudio）。 */
  readonly managedRoot: string;
  readonly filesystem?: ProjectDirectoryFilesystem;
  readonly logWarn?: ProjectDirectoryWarnSink;
}

const defaultLogWarn: ProjectDirectoryWarnSink = (message) => {
  process.stderr.write(`${message}\n`);
};

const nodeFilesystem: ProjectDirectoryFilesystem = {
  mkdir: (directory, options) => mkdir(directory, options).then(() => undefined),
  stat: (target) => stat(target),
  realpath: (target) => realpath(target),
  open: (target, flags) => open(target, flags),
  unlink: (target) => unlink(target),
  rmdir: (directory) => rmdir(directory),
  readdir: (directory) => readdir(directory),
};

const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
};

const errnoCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

const toDirectoryError = (): ProjectDirectoryError =>
  new ProjectDirectoryError('PROJECT_DIRECTORY_UNAVAILABLE');

export class ProjectDirectoryAdapter implements ProjectDirectoryPort {
  readonly #projectsRoot: string;
  readonly #filesystem: ProjectDirectoryFilesystem;
  readonly #logWarn: ProjectDirectoryWarnSink;

  public constructor({
    managedRoot,
    filesystem = nodeFilesystem,
    logWarn = defaultLogWarn,
  }: ProjectDirectoryAdapterOptions) {
    const resolvedRoot = path.resolve(managedRoot);
    this.#projectsRoot = path.join(resolvedRoot, PROJECTS_SEGMENT);
    this.#filesystem = filesystem;
    this.#logWarn = logWarn;
  }

  public async prepare(projectId: string): Promise<ProjectDirectoryHandle> {
    this.#assertProjectId(projectId);
    const directory = path.join(this.#projectsRoot, projectId);
    if (!isWithin(this.#projectsRoot, directory)) {
      throw new ProjectDirectoryError('PROJECT_DIRECTORY_INVALID_ID');
    }

    // 先探测目录是否已存在，确定 created 标志（用于后续补偿清理）
    const created = await this.#detectCreated(directory);
    try {
      await this.#filesystem.mkdir(directory, { recursive: true });
      await this.#assertRealPathContained(directory);
      await this.#probeWritable(directory);
    } catch (error) {
      await this.#bestEffortRemoveIfCreated(directory, projectId, created);
      if (error instanceof ProjectDirectoryError) throw error;
      throw toDirectoryError();
    }
    return { projectId, created };
  }

  public async cleanupIfCreatedEmpty(
    handle: ProjectDirectoryHandle,
  ): Promise<DirectoryCleanupOutcome> {
    // handle.created=false：本次 prepare 未创建（预存或崩溃遗留），绝不删除
    if (!handle.created) return { skipped: 'NOT_CREATED' };

    let directory: string;
    try {
      this.#assertProjectId(handle.projectId);
      directory = path.join(this.#projectsRoot, handle.projectId);
      if (!isWithin(this.#projectsRoot, directory)) {
        this.#warn(handle.projectId, 'cleanup', 'invalid-id');
        return { skipped: 'PREEXISTING' };
      }
    } catch {
      this.#warn(handle.projectId, 'cleanup', 'invalid-id');
      return { skipped: 'PREEXISTING' };
    }

    try {
      const entries = await this.#filesystem.readdir(directory);
      if (entries.length > 0) return { skipped: 'NOT_EMPTY' };
      await this.#assertRealPathContained(directory);
      await this.#filesystem.rmdir(directory);
      return { deleted: true };
    } catch (error) {
      // 目录已不在（已被删除 / 从未真正落地）：良性跳过，不告警
      if (errnoCode(error) === 'ENOENT') return { skipped: 'NOT_CREATED' };
      // realpath 逃逸或 rmdir 失败：只产生脱敏 WARN，绝不递归删、不覆盖、不抛出
      this.#warn(handle.projectId, 'cleanup', 'remove-failed');
      return { skipped: 'PREEXISTING' };
    }
  }

  readonly #assertProjectId = (projectId: string): void => {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      throw new ProjectDirectoryError('PROJECT_DIRECTORY_INVALID_ID');
    }
  };

  readonly #detectCreated = async (directory: string): Promise<boolean> => {
    try {
      const stats = await this.#filesystem.stat(directory);
      if (!stats.isDirectory()) {
        // 目标位置是个文件——受管理根损坏，目录不可用
        throw new ProjectDirectoryError('PROJECT_DIRECTORY_UNAVAILABLE');
      }
      return false;
    } catch (error) {
      if (error instanceof ProjectDirectoryError) throw error;
      if (errnoCode(error) === 'ENOENT') return true;
      throw toDirectoryError();
    }
  };

  readonly #assertRealPathContained = async (directory: string): Promise<void> => {
    const realRoot = await this.#filesystem.realpath(this.#projectsRoot);
    const realDirectory = await this.#filesystem.realpath(directory);
    if (!isWithin(realRoot, realDirectory)) {
      // 目录被符号链接到受管理根之外——拦截逃逸，绝不操作外部路径
      throw new ProjectDirectoryError('PROJECT_DIRECTORY_PATH_ESCAPE');
    }
  };

  readonly #probeWritable = async (directory: string): Promise<void> => {
    // 同根临时写入/flush/delete 探测：确认目录真正可写，父目录不可写或磁盘满会在此暴露
    const probe = path.join(directory, `${PROBE_PREFIX}${randomUUID()}`);
    const handle = await this.#filesystem.open(probe, 'wx');
    try {
      await handle.writeFile('jingxu');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.#filesystem.unlink(probe);
  };

  readonly #bestEffortRemoveIfCreated = async (
    directory: string,
    projectId: string,
    created: boolean,
  ): Promise<void> => {
    if (!created) return;
    try {
      await this.#filesystem.rmdir(directory);
    } catch {
      // prepare 失败后尽力清理本次新建的空目录；清理失败仅脱敏 WARN，不掩盖原始错误
      this.#warn(projectId, 'prepare-compensation', 'remove-failed');
    }
  };

  readonly #warn = (projectId: string, operation: string, reason: string): void => {
    this.#logWarn(
      `project-directory operation=${operation} projectId=${projectId} reason=${reason}`,
    );
  };
}
