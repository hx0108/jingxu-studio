import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ProjectDirectoryFileHandle,
  ProjectDirectoryFilesystem,
  ProjectDirectoryWarnSink,
} from './project-directory-adapter';
import { ProjectDirectoryAdapter, ProjectDirectoryError } from './project-directory-adapter';

const VALID_ID = 'proj_0123456789abcdef';
const PROBE_PREFIX = '.jingxu-write-probe-';

const roots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-dir-test-'));
  roots.push(root);
  return root;
};

const errnoException = (code: string): NodeJS.ErrnoException => {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

const createFakeHandle = (
  overrides: Readonly<Partial<ProjectDirectoryFileHandle>> = {},
): ProjectDirectoryFileHandle => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  sync: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

const createFilesystem = (
  overrides: Readonly<Partial<ProjectDirectoryFilesystem>> = {},
): ProjectDirectoryFilesystem => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockRejectedValue(errnoException('ENOENT')),
  realpath: vi.fn().mockImplementation((target: string) => Promise.resolve(target)),
  open: vi.fn().mockResolvedValue(createFakeHandle()),
  unlink: vi.fn().mockResolvedValue(undefined),
  rmdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  ...overrides,
});

const assertInvalidId = async (root: string, projectId: string): Promise<void> => {
  const adapter = new ProjectDirectoryAdapter({ managedRoot: root });
  await expect(adapter.prepare(projectId)).rejects.toThrow(ProjectDirectoryError);
  await expect(adapter.prepare(projectId)).rejects.toThrow('PROJECT_DIRECTORY_INVALID_ID');
  // 失败时不得创建任何目录，也不得泄漏路径
  const projectsRoot = path.join(root, 'projects');
  await expect(readdir(projectsRoot)).rejects.toThrow();
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('ProjectDirectoryAdapter — prepare (§6.1)', () => {
  it('系统派生 projects/<project_id>—新建—返回 created=true 且目录存在', async () => {
    const root = await makeRoot();
    const adapter = new ProjectDirectoryAdapter({ managedRoot: root });

    const handle = await adapter.prepare(VALID_ID);

    expect(handle).toStrictEqual({ projectId: VALID_ID, created: true });
    const entries = await readdir(path.join(root, 'projects'));
    expect(entries).toEqual([VALID_ID]);
  });

  it('同根临时写入/flush/delete 探测—完成后不残留探针文件', async () => {
    const root = await makeRoot();
    const adapter = new ProjectDirectoryAdapter({ managedRoot: root });

    await adapter.prepare(VALID_ID);

    const projectDir = path.join(root, 'projects', VALID_ID);
    const entries = await readdir(projectDir);
    expect(entries.filter((entry) => entry.startsWith(PROBE_PREFIX))).toEqual([]);
  });

  it('返回 handle 不含路径—仅 projectId/created 两个键', async () => {
    const root = await makeRoot();
    const adapter = new ProjectDirectoryAdapter({ managedRoot: root });

    const handle = await adapter.prepare(VALID_ID);

    expect(Object.keys(handle).sort()).toEqual(['created', 'projectId']);
    expect(JSON.stringify(handle)).not.toContain(root);
    expect(JSON.stringify(handle)).not.toContain(path.sep);
  });

  it('目录已存在—prepare 返回 created=false 且不报错', async () => {
    const root = await makeRoot();
    const projectDir = path.join(root, 'projects', VALID_ID);
    await mkdir(projectDir, { recursive: true });
    const adapter = new ProjectDirectoryAdapter({ managedRoot: root });

    const handle = await adapter.prepare(VALID_ID);

    expect(handle).toStrictEqual({ projectId: VALID_ID, created: false });
  });

  it.each([
    ['空串', ''],
    ['过短', 'abcdefghijk'],
    ['含空格', 'has space'],
    ['含正斜杠', 'has/slash'],
    ['含反斜杠', 'has\\slash'],
    ['含点号', 'has.dot'],
    ['含分号', 'has;rm'],
    ['相对逃逸', '../../etc/passwd'],
    ['超长', 'a'.repeat(65)],
  ])('非法 ID(%s)—拒绝且不创建目录、不泄漏路径', async (_label, projectId) => {
    const root = await makeRoot();
    await assertInvalidId(root, projectId);
  });

  it('父目录不可写(managedRoot 是文件)—prepare 抛 PROJECT_DIRECTORY_UNAVAILABLE', async () => {
    const root = await makeRoot();
    // 受管理根位置被文件占据：其下无法创建目录
    await writeFile(path.join(root, 'blocker'), 'not a directory');
    const warn = vi.fn<ProjectDirectoryWarnSink>();
    const adapter = new ProjectDirectoryAdapter({
      managedRoot: path.join(root, 'blocker'),
      logWarn: warn,
    });

    await expect(adapter.prepare(VALID_ID)).rejects.toThrow('PROJECT_DIRECTORY_UNAVAILABLE');
    // prepare 失败后的补偿清理若触发，WARN 必须脱敏（平台相关是否触发，故只校验不泄漏路径）
    for (const [message] of warn.mock.calls) {
      expect(message).not.toContain(root);
      expect(message).not.toContain(path.sep);
    }
  });

  it('符号链接/路径逃逸(realpath 落在受管理根外)—拦截且不操作外部路径', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const rmdir = vi.fn().mockResolvedValue(undefined);
    const filesystem = createFilesystem({
      realpath: vi
        .fn()
        .mockImplementation((target: string) =>
          Promise.resolve(target.endsWith(VALID_ID) ? outside : target),
        ),
      rmdir,
    });
    const adapter = new ProjectDirectoryAdapter({ managedRoot: root, filesystem });

    await expect(adapter.prepare(VALID_ID)).rejects.toThrow('PROJECT_DIRECTORY_PATH_ESCAPE');
    // 失败时尽力清理本次新建目录；外部目录绝不被触碰
    expect(rmdir).toHaveBeenCalledWith(path.join(root, 'projects', VALID_ID));
  });

  it('临时写入探测 open 失败—prepare 抛 PROJECT_DIRECTORY_UNAVAILABLE 且不泄漏路径', async () => {
    const root = await makeRoot();
    const filesystem = createFilesystem({
      open: vi.fn().mockRejectedValue(errnoException('EACCES')),
    });
    const adapter = new ProjectDirectoryAdapter({ managedRoot: root, filesystem });

    await expect(adapter.prepare(VALID_ID)).rejects.toThrow('PROJECT_DIRECTORY_UNAVAILABLE');
  });

  it('临时写入 writeFile 失败—prepare 抛 PROJECT_DIRECTORY_UNAVAILABLE', async () => {
    const root = await makeRoot();
    const filesystem = createFilesystem({
      open: vi
        .fn()
        .mockResolvedValue(
          createFakeHandle({ writeFile: vi.fn().mockRejectedValue(errnoException('ENOSPC')) }),
        ),
    });
    const adapter = new ProjectDirectoryAdapter({ managedRoot: root, filesystem });

    await expect(adapter.prepare(VALID_ID)).rejects.toThrow('PROJECT_DIRECTORY_UNAVAILABLE');
  });

  it('flush(sync) 探测失败—prepare 抛 PROJECT_DIRECTORY_UNAVAILABLE', async () => {
    const root = await makeRoot();
    const filesystem = createFilesystem({
      open: vi
        .fn()
        .mockResolvedValue(
          createFakeHandle({ sync: vi.fn().mockRejectedValue(errnoException('EIO')) }),
        ),
    });
    const adapter = new ProjectDirectoryAdapter({ managedRoot: root, filesystem });

    await expect(adapter.prepare(VALID_ID)).rejects.toThrow('PROJECT_DIRECTORY_UNAVAILABLE');
  });

  it('delete(unlink) 探测失败—prepare 抛 PROJECT_DIRECTORY_UNAVAILABLE', async () => {
    const root = await makeRoot();
    const filesystem = createFilesystem({
      unlink: vi.fn().mockRejectedValue(errnoException('EACCES')),
    });
    const adapter = new ProjectDirectoryAdapter({ managedRoot: root, filesystem });

    await expect(adapter.prepare(VALID_ID)).rejects.toThrow('PROJECT_DIRECTORY_UNAVAILABLE');
  });
});

describe('ProjectDirectoryAdapter — cleanup (§6.2)', () => {
  it('仅删本次创建且仍为空的目录—deleted=true 且目录消失', async () => {
    const root = await makeRoot();
    const adapter = new ProjectDirectoryAdapter({ managedRoot: root });
    const handle = await adapter.prepare(VALID_ID);
    const projectDir = path.join(root, 'projects', VALID_ID);

    const outcome = await adapter.cleanupIfCreatedEmpty(handle);

    expect(outcome).toStrictEqual({ deleted: true });
    await expect(readdir(projectDir)).rejects.toThrow();
  });

  it('预存目录(created=false)—跳过 NOT_CREATED 且目录保留', async () => {
    const root = await makeRoot();
    const projectDir = path.join(root, 'projects', VALID_ID);
    await mkdir(projectDir, { recursive: true });
    const adapter = new ProjectDirectoryAdapter({ managedRoot: root });
    const handle = await adapter.prepare(VALID_ID);

    const outcome = await adapter.cleanupIfCreatedEmpty(handle);

    expect(outcome).toStrictEqual({ skipped: 'NOT_CREATED' });
    expect(await readdir(projectDir)).toEqual([]);
  });

  it('非空目录—跳过 NOT_EMPTY，不递归删除、保留用户内容', async () => {
    const root = await makeRoot();
    const adapter = new ProjectDirectoryAdapter({ managedRoot: root });
    const handle = await adapter.prepare(VALID_ID);
    const projectDir = path.join(root, 'projects', VALID_ID);
    await writeFile(path.join(projectDir, 'user-content.txt'), 'keep me');

    const outcome = await adapter.cleanupIfCreatedEmpty(handle);

    expect(outcome).toStrictEqual({ skipped: 'NOT_EMPTY' });
    expect(await readdir(projectDir)).toEqual(['user-content.txt']);
  });

  it('崩溃遗留目录—再次 prepare 视为预存—cleanup 跳过且不删除', async () => {
    const root = await makeRoot();
    const adapter = new ProjectDirectoryAdapter({ managedRoot: root });
    // 首次 prepare 创建目录后“崩溃”：拿到 handle 但不清理
    await adapter.prepare(VALID_ID);
    const projectDir = path.join(root, 'projects', VALID_ID);
    expect(await readdir(projectDir)).toEqual([]);

    // 进程重启后再次 prepare：目录已存在 → created=false
    const handleAfterCrash = await adapter.prepare(VALID_ID);
    expect(handleAfterCrash).toStrictEqual({ projectId: VALID_ID, created: false });

    const outcome = await adapter.cleanupIfCreatedEmpty(handleAfterCrash);
    expect(outcome).toStrictEqual({ skipped: 'NOT_CREATED' });
    // 崩溃遗留的空目录不被自动递归清理
    expect(await readdir(projectDir)).toEqual([]);
  });

  it('目录已不在(ENOENT)—良性跳过 NOT_CREATED 且不告警', async () => {
    const root = await makeRoot();
    const warn = vi.fn();
    const adapter = new ProjectDirectoryAdapter({ managedRoot: root, logWarn: warn });
    const handle = { projectId: VALID_ID, created: true } as const;

    const outcome = await adapter.cleanupIfCreatedEmpty(handle);

    expect(outcome).toStrictEqual({ skipped: 'NOT_CREATED' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('rmdir 失败—跳过 PREEXISTING、只产生脱敏 WARN、不抛出、不泄漏路径', async () => {
    const root = await makeRoot();
    const warn = vi.fn<ProjectDirectoryWarnSink>();
    const filesystem = createFilesystem({
      rmdir: vi.fn().mockRejectedValue(errnoException('EACCES')),
    });
    const adapter = new ProjectDirectoryAdapter({
      managedRoot: root,
      filesystem,
      logWarn: warn,
    });
    const handle = { projectId: VALID_ID, created: true } as const;

    const outcome = await adapter.cleanupIfCreatedEmpty(handle);

    expect(outcome).toStrictEqual({ skipped: 'PREEXISTING' });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] ?? '';
    expect(message).toContain(VALID_ID);
    expect(message).toContain('cleanup');
    expect(message).not.toContain(root);
    expect(message).not.toContain(path.sep);
  });
});
