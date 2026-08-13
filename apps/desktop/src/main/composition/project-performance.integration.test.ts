import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { createProjectService, createStableHasher } from '@jingxu/application';
import { afterEach, describe, expect, it } from 'vitest';

import { ProjectDirectoryAdapter } from '../project/project-directory-adapter';
import { createDesktopPersistenceRuntime } from './create-persistence-runtime';

const MIGRATION_DIRECTORY = path.resolve(
  import.meta.dirname,
  '../../../../../packages/persistence/resources/migrations',
);
const SCHEMA_RESOURCE_DIRECTORY = path.resolve(
  import.meta.dirname,
  '../../../../../packages/validation/resources/schemas/v1',
);
const ITERATIONS = 30;

const percentile = (values: readonly number[], quantile: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
};

describe('Project create/update 固定环境性能证据（§9.5）', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it('临时库真实目录—重复 create/update—记录 P50/P95 且目录 I/O 位于事务外', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-project-performance-'));
    roots.push(root);
    const managedRoot = path.join(root, 'managed');
    const runtime = await createDesktopPersistenceRuntime({
      clock: () => new Date().toISOString(),
      managedRoot,
      migrationDirectory: MIGRATION_DIRECTORY,
      schemaResourceDirectory: SCHEMA_RESOURCE_DIRECTORY,
    });
    const unitOfWork = runtime.getProjectUnitOfWork();
    if (unitOfWork === null) throw new Error('performance runtime must be READY');

    const actualDirectory = new ProjectDirectoryAdapter({ managedRoot });
    const directoryDurations: number[] = [];
    const directory = {
      cleanupIfCreatedEmpty: actualDirectory.cleanupIfCreatedEmpty.bind(actualDirectory),
      prepare: async (projectId: string) => {
        const startedAt = performance.now();
        const handle = await actualDirectory.prepare(projectId);
        directoryDurations.push(performance.now() - startedAt);
        return handle;
      },
    };
    let idSequence = 0;
    const service = createProjectService({
      clock: { now: Date.now },
      directory,
      hasher: createStableHasher((input) => createHash('sha256').update(input).digest('hex')),
      idGenerator: {
        newId: () => `entity_${String(++idSequence).padStart(12, '0')}`,
      },
      unitOfWork,
    });
    const createDurations: number[] = [];
    const updateDurations: number[] = [];

    try {
      for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
        const suffix = String(iteration).padStart(4, '0');
        const createStartedAt = performance.now();
        const created = await service.create(
          {
            requestId: `request_create_${suffix}`,
            name: `性能项目-${suffix}`,
            genre: null,
            style: null,
            creationMode: 'AI_ORIGINAL',
            dialogueRenderMode: 'NARRATION_FIRST',
            aspectRatio: '9:16',
            subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
          },
          `trace_create_${suffix}`,
        );
        createDurations.push(performance.now() - createStartedAt);
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error('create performance sample failed');

        const updateStartedAt = performance.now();
        const updated = await service.update(
          {
            requestId: `request_update_${suffix}`,
            projectId: created.data.id,
            expectedUpdatedAt: created.data.updatedAt,
            name: created.data.name,
            genre: '性能',
            style: null,
            dialogueRenderMode: created.data.dialogueRenderMode,
            aspectRatio: '16:9',
            subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
          },
          `trace_update_${suffix}`,
        );
        updateDurations.push(performance.now() - updateStartedAt);
        expect(updated.ok).toBe(true);
      }
    } finally {
      runtime.close();
    }

    const evidence = {
      architecture: process.arch,
      createP50Ms: percentile(createDurations, 0.5),
      createP95Ms: percentile(createDurations, 0.95),
      directoryPrepareP50Ms: percentile(directoryDurations, 0.5),
      directoryPrepareP95Ms: percentile(directoryDurations, 0.95),
      iterations: ITERATIONS,
      node: process.version,
      platform: process.platform,
      updateP50Ms: percentile(updateDurations, 0.5),
      updateP95Ms: percentile(updateDurations, 0.95),
    };
    expect(directoryDurations).toHaveLength(ITERATIONS);
    expect(Object.values(evidence).every((value) => typeof value !== 'number' || value >= 0)).toBe(
      true,
    );
    // Wall-clock values are evidence only; deterministic statement/I/O gates live in persistence.
    process.stdout.write(`JINGXU_PROJECT_PERFORMANCE ${JSON.stringify(evidence)}\n`);
  });
});
