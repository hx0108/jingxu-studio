import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { V1_SCHEMA_LOCKS } from '@jingxu/validation';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const resourceRoot = path.join(
  repositoryRoot,
  'packages',
  'validation',
  'resources',
  'schemas',
  'v1',
);

const sourceByResourceName: Readonly<Record<string, string>> = {
  'ScriptStageOutput.schema.json': '镜序Studio_V1_ScriptStageOutput.schema.json',
  'ShotContract.schema.json': '镜序Studio_V1_ShotContract.schema.json',
  'EpisodeStoryboardExport.schema.json': '镜序Studio_V1_EpisodeStoryboardExport.schema.json',
  'ProjectTransferBundle.schema.json': '镜序Studio_V1_ProjectTransferBundle.schema.json',
};

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('V1 Schema 受控资源副本', () => {
  it('根 Schema—对账资源副本—源与副本逐字节匹配静态锁且没有额外文件', async () => {
    const resourceNames = (await readdir(resourceRoot)).sort();
    expect(resourceNames).toEqual(V1_SCHEMA_LOCKS.map((lock) => lock.resourceName).sort());

    for (const lock of V1_SCHEMA_LOCKS) {
      const sourceName = sourceByResourceName[lock.resourceName];
      expect(sourceName).toBeDefined();
      const [source, resource] = await Promise.all([
        readFile(path.join(repositoryRoot, sourceName ?? 'missing')),
        readFile(path.join(resourceRoot, lock.resourceName)),
      ]);

      expect(hash(source)).toBe(lock.sha256);
      expect(hash(resource)).toBe(lock.sha256);
      expect(resource.equals(source)).toBe(true);
    }
  });
});
