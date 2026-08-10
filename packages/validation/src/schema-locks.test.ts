import { describe, expect, it } from 'vitest';

import {
  SCHEMA_DRAFT_2020_12,
  SchemaRegistryConfigurationError,
  V1_SCHEMA_LOCKS,
  assertValidSchemaLocks,
  getV1SchemaLock,
} from './schema-locks';

const expectedLocks = [
  {
    schemaId: 'https://jingxu.studio/schemas/script-stage-output/1.0.0',
    semanticVersion: '1.0.0',
    resourceName: 'ScriptStageOutput.schema.json',
    sha256: '128e7a49e1d5829c4b0c9cf89fc5e6fd883746f022e9759c157f70176309971f',
  },
  {
    schemaId: 'https://jingxu.studio/schemas/shot-contract/1.1.0',
    semanticVersion: '1.1.0',
    resourceName: 'ShotContract.schema.json',
    sha256: '3fa77aa85152ad2500fcc1c07da5bec697da8810c572d1c378b0bf432f437e4b',
  },
  {
    schemaId: 'https://jingxu.studio/schemas/episode-storyboard-export/1.1.0',
    semanticVersion: '1.1.0',
    resourceName: 'EpisodeStoryboardExport.schema.json',
    sha256: '55238d1958aae25341d137192cf544946b9d8b8767648a98a3956e01798fcb13',
  },
  {
    schemaId: 'https://jingxu.studio/schemas/project-transfer-bundle/1.0.0',
    semanticVersion: '1.0.0',
    resourceName: 'ProjectTransferBundle.schema.json',
    sha256: '9736ee2421fa8b8febe683c6e41e3cae47665df5d7afe85592a25e4fa4fbabbb',
  },
] as const;

describe('V1 Schema 静态锁清单', () => {
  it('内置锁—读取清单—恰好公开四个唯一且完整的只读记录', () => {
    expect(V1_SCHEMA_LOCKS).toHaveLength(4);
    expect(
      V1_SCHEMA_LOCKS.map((lock) => ({
        schemaId: lock.schemaId,
        semanticVersion: lock.semanticVersion,
        resourceName: lock.resourceName,
        sha256: lock.sha256,
      })),
    ).toEqual(expectedLocks);
    expect(new Set(V1_SCHEMA_LOCKS.map((lock) => lock.schemaId))).toHaveProperty('size', 4);
    expect(new Set(V1_SCHEMA_LOCKS.map((lock) => lock.resourceName))).toHaveProperty('size', 4);

    for (const lock of V1_SCHEMA_LOCKS) {
      expect(lock.draft).toBe(SCHEMA_DRAFT_2020_12);
      expect(lock.schemaId.endsWith(`/${lock.semanticVersion}`)).toBe(true);
      expect(lock.resourceName).toMatch(/^[\x20-\x7e]+$/u);
      expect(lock.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(Object.isFrozen(lock)).toBe(true);
    }
    expect(Object.isFrozen(V1_SCHEMA_LOCKS)).toBe(true);
  });

  it.each([
    [
      '重复 Schema ID',
      [{ ...expectedLocks[0] }, { ...expectedLocks[0], resourceName: 'other.json' }],
    ],
    [
      '重复逻辑资源名',
      [
        { ...expectedLocks[0] },
        { ...expectedLocks[1], resourceName: expectedLocks[0].resourceName },
      ],
    ],
    ['缺少必填字段', [{ schemaId: expectedLocks[0].schemaId }]],
  ])('%s—核验清单—返回 SCHEMA_MANIFEST_INVALID', (_label, candidate) => {
    expect(() => {
      assertValidSchemaLocks(candidate);
    }).toThrow(expect.objectContaining({ code: 'SCHEMA_MANIFEST_INVALID' }));
  });

  it('未知完整 ID—查询静态锁—返回 SCHEMA_ID_NOT_REGISTERED', () => {
    expect(() => getV1SchemaLock('https://jingxu.studio/schemas/unknown/1.0.0')).toThrow(
      expect.objectContaining({ code: 'SCHEMA_ID_NOT_REGISTERED' }),
    );
  });

  it('配置错误—暴露稳定错误码—不泄漏候选清单', () => {
    try {
      assertValidSchemaLocks([{ secret: 'do-not-leak' }]);
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaRegistryConfigurationError);
      expect(String(error)).not.toContain('do-not-leak');
    }
  });
});
