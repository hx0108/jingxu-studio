import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProjectDirectoryPort } from '@jingxu/application';

import { createProjectDirectoryAdapter } from './create-project-directory';

const VALID_ID = 'proj_0123456789abcdef';

const roots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-dir-comp-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('Main Project Directory Composition Root (§6.3)', () => {
  it('从受管理根构造—返回 ProjectDirectoryPort—可被 Composition Root 注入', () => {
    const port: ProjectDirectoryPort = createProjectDirectoryAdapter({ managedRoot: os.tmpdir() });
    // 端口只暴露 prepare/cleanupIfCreatedEmpty，不暴露路径、FileHandle 或 persistence 细节
    expect(typeof port.prepare).toBe('function');
    expect(typeof port.cleanupIfCreatedEmpty).toBe('function');
  });

  it('端到端 round-trip—事务外 fs I/O—handle 与目录均不含绝对路径泄漏', async () => {
    const root = await makeRoot();
    const port = createProjectDirectoryAdapter({ managedRoot: root });

    // prepare 在事务外完成（本用例无 SQLite/事务参与），返回不透明句柄
    const handle = await port.prepare(VALID_ID);
    expect(Object.keys(handle).sort()).toEqual(['created', 'projectId']);
    expect(await readdir(path.join(root, 'projects'))).toEqual([VALID_ID]);

    // cleanup 补偿：删本次新建且仍空的目录
    const outcome = await port.cleanupIfCreatedEmpty(handle);
    expect(outcome).toStrictEqual({ deleted: true });
    await expect(readdir(path.join(root, 'projects', VALID_ID))).rejects.toThrow();
  });

  it('端到端—预存目录不被覆盖—prepare 复用并返回 created=false', async () => {
    const root = await makeRoot();
    const projectDir = path.join(root, 'projects', VALID_ID);
    await mkdir(projectDir, { recursive: true });
    const port = createProjectDirectoryAdapter({ managedRoot: root });

    const handle = await port.prepare(VALID_ID);

    expect(handle).toStrictEqual({ projectId: VALID_ID, created: false });
    // Composition Root 注入的端口同样遵守“不递归删、不覆盖预存目录”
    expect(await port.cleanupIfCreatedEmpty(handle)).toStrictEqual({ skipped: 'NOT_CREATED' });
    expect(await readdir(projectDir)).toEqual([]);
  });
});
