import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createDemoSeeder } from './create-demo-seeder';
import { demoProjectRegistry } from './demo-project-registry';
import {
  createDesktopPersistenceRuntime,
  type DesktopPersistenceRuntime,
} from './create-persistence-runtime';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..');
const MIGRATION_DIRECTORY = path.join(
  REPO_ROOT,
  'packages',
  'persistence',
  'resources',
  'migrations',
);
const SCHEMA_RESOURCE_DIRECTORY = path.join(
  REPO_ROOT,
  'packages',
  'validation',
  'resources',
  'schemas',
  'v1',
);

let runtime: DesktopPersistenceRuntime | null = null;
let root: string | null = null;

const bootRuntime = async (): Promise<DesktopPersistenceRuntime> => {
  if (runtime !== null) return runtime;
  root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-demo-seed-'));
  runtime = await createDesktopPersistenceRuntime({
    clock: () => new Date().toISOString(),
    managedRoot: path.join(root, 'managed'),
    migrationDirectory: MIGRATION_DIRECTORY,
    schemaResourceDirectory: SCHEMA_RESOURCE_DIRECTORY,
  });
  return runtime;
};

afterAll(async () => {
  runtime?.close();
  if (root !== null) await rm(root, { force: true, recursive: true });
});

describe('五分钟体验种子（3.3 集成·真实 SQLite 运行时）', () => {
  it('无凭据离线种子—五阶段与分镜全部 READY—项目标记 DEMO', async () => {
    const booted = await bootRuntime();
    const seeder = createDemoSeeder({ persistenceRuntime: booted });
    const result = await seeder.seed('request_seed_it01');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ isDemo: true, resumed: false });
    const projectId = result.data.projectId;
    expect(demoProjectRegistry.current()).toBe(projectId);

    const workspace = await booted.getScriptWorkspaceQuery()?.getWorkspace(projectId);
    expect(workspace).not.toBeNull();
    const stages = workspace?.stages ?? [];
    for (const stage of [
      'CONCEPT',
      'STORY_BIBLE',
      'EPISODE_OUTLINE',
      'BEAT_SHEET',
      'SCENE_SCRIPT',
    ]) {
      const current = stages.find((item) => item.stage === stage)?.current;
      expect(current?.status, stage).toBe('READY');
    }
    expect(workspace?.storyboard.current?.status).toBe('READY');
    expect((workspace?.storyboard.currentShots ?? []).length).toBeGreaterThan(0);

    const projects = booted.getProjectUnitOfWork();
    const demo = await projects?.run(({ projects: repository }) =>
      repository.findById(projectId, 'ACTIVE'),
    );
    expect(demo?.experienceMode).toBe('DEMO');
  }, 60_000);

  it('再次种子—幂等恢复同一演示项目—不复制', async () => {
    const booted = await bootRuntime();
    const seeder = createDemoSeeder({ persistenceRuntime: booted });
    const first = await seeder.seed('request_seed_it01');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await seeder.seed('request_seed_it02');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.resumed).toBe(true);
    expect(second.data.projectId).toBe(first.data.projectId);
  }, 60_000);

  it('演示项目被移入回收站后—种子重新创建全新示例—登记指向新项目', async () => {
    const booted = await bootRuntime();
    const seeder = createDemoSeeder({ persistenceRuntime: booted });
    const first = await seeder.seed('request_seed_it03');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const oldId = first.data.projectId;
    const projects = booted.getProjectUnitOfWork();
    await projects?.run(async ({ projects: repository }) => {
      const project = await repository.findById(oldId, 'ACTIVE');
      if (project === null) throw new Error('demo project missing');
      await repository.update(
        { ...project, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        project.updatedAt,
      );
    });
    const second = await seeder.seed('request_seed_it04');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.resumed).toBe(false);
    expect(second.data.projectId).not.toBe(oldId);
    expect(demoProjectRegistry.current()).toBe(second.data.projectId);
  }, 60_000);
});
