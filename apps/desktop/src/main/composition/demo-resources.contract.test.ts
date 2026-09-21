import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { V1_SCHEMA_IDS, V1_SCHEMA_LOCKS, buildSchemaRegistry } from '@jingxu/validation';
import { beforeAll, describe, expect, it } from 'vitest';

import type { LockedSchemaResource, SchemaRegistry } from '@jingxu/validation';

const demoRoot = path.resolve(import.meta.dirname, '../../../resources/demo');
const schemaRoot = path.resolve(
  import.meta.dirname,
  '../../../../../packages/validation/resources/schemas/v1',
);

interface DemoStoryFixture {
  readonly fixtureVersion: string;
  readonly projectDefaults: {
    readonly aspectRatio: string;
    readonly dialogueRenderMode: string;
    readonly targetDurationSec: number;
  };
  readonly stages: readonly unknown[];
  readonly title: string;
}

interface DemoManifest {
  readonly files: Readonly<Record<string, string>>;
  readonly notice: string;
  readonly version: string;
}

let registry: SchemaRegistry;

beforeAll(async () => {
  const resources: readonly LockedSchemaResource[] = await Promise.all(
    V1_SCHEMA_LOCKS.map(async (lock) => ({
      bytes: Uint8Array.from(await readFile(path.join(schemaRoot, lock.resourceName))),
      resourceName: lock.resourceName,
    })),
  );
  registry = await buildSchemaRegistry(V1_SCHEMA_LOCKS, resources);
});

describe('五分钟体验合成资源', () => {
  it('manifest—三份随包资源 SHA-256 完全匹配且文案声明 Mock/零费用', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(demoRoot, 'demo-manifest.json'), 'utf8'),
    ) as DemoManifest;
    expect(manifest.version).toBe('jingxu-demo/1');
    expect(manifest.notice).toContain('Mock');
    expect(manifest.notice).toContain('不会产生真实费用');

    for (const [name, expectedHash] of Object.entries(manifest.files)) {
      const bytes = await readFile(path.join(demoRoot, name));
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(expectedHash);
    }
  });

  it('示例故事—五阶段均通过正式 ScriptStageOutput Schema 且默认参数固定', async () => {
    const fixture = JSON.parse(
      await readFile(path.join(demoRoot, 'demo-story.json'), 'utf8'),
    ) as DemoStoryFixture;
    expect(fixture.fixtureVersion).toBe('jingxu-demo/1');
    expect(fixture.projectDefaults).toEqual({
      aspectRatio: '9:16',
      dialogueRenderMode: 'NARRATION_FIRST',
      targetDurationSec: 60,
    });
    expect(fixture.stages).toHaveLength(5);
    for (const stage of fixture.stages) {
      expect(
        registry.validate(V1_SCHEMA_IDS.scriptStageOutput, stage),
        JSON.stringify(stage),
      ).toEqual({
        issues: [],
        schemaId: V1_SCHEMA_IDS.scriptStageOutput,
        valid: true,
      });
    }
  });
});
