import { describe, expect, it } from 'vitest';

import type { TransferJson } from '../ports/transfer';
import {
  buildTransferIdMapping,
  collectTransferSourceIds,
  decodeTransferBytes,
  parseTransferJson,
  rewriteTransferReferences,
  TransferValidationError,
  validateTransferBundleShape,
  validateTransferHash,
  validateTransferReferences,
} from './transfer-staging';

const encoder = new TextEncoder();

const shot = (sequence: number): TransferJson => ({
  contract_version: 1,
  continuity: { previous_shot_id: null },
  parent_version_id: null,
  sequence,
  shot_id: `shot_000${String(sequence)}`,
  status: 'READY',
  version_id: `scv_000${String(sequence)}`,
});

const validBundle: TransferJson = {
  bundle_id: 'bundle_0001',
  episode_storyboard: {
    episode_id: 'episode_0001',
    episode_version: 1,
    format_profile: { id: 'format_0001' },
    project_id: 'project_0001',
    shot_contracts: [shot(1), shot(2)],
    story_bible_version_id: 'sbv_0001',
  },
  exported_at: '2026-08-21T10:00:00+08:00',
  project_snapshot: {
    creation_mode: 'AI_ORIGINAL',
    dialogue_render_mode: 'NARRATION_FIRST',
    name: '雾都来信',
    project_id: 'project_0001',
  },
  schema_version: '1.0.0',
  script_stage_outputs: [
    { output: { stage: 'CONCEPT' }, version_id: 'scv_c1' },
    { output: { stage: 'EPISODE_OUTLINE' }, version_id: 'scv_o1' },
    { output: { stage: 'BEAT_SHEET' }, version_id: 'scv_b1' },
    { output: { stage: 'SCENE_SCRIPT' }, version_id: 'scv_s1' },
  ],
  story_bible: { output: { stage: 'STORY_BIBLE' }, version_id: 'sbv_0001' },
};

const expectCode = (action: () => void, code: string): void => {
  expect(action).toThrow(TransferValidationError);
  try {
    action();
  } catch (caught) {
    expect((caught as TransferValidationError).code).toBe(code);
  }
};

const clone = (bundle: TransferJson): TransferJson =>
  JSON.parse(JSON.stringify(bundle)) as TransferJson;

type MutableJson = Record<string, unknown>;
const mutable = (value: unknown): MutableJson => value as MutableJson;

describe('staging 校验链（project-transfer-import-export 2.2）', () => {
  it.each([
    ['超限文件', Uint8Array.from({ length: 32 * 1024 * 1024 + 1 }, () => 32)],
    ['非法 UTF-8 字节', new Uint8Array([0x22, 0xff, 0x22])],
    ['UTF-8 BOM 开头', encoder.encode('﻿{}')],
  ])('大小/UTF-8 解码—%s—单一稳定错误 TRANSFER_BUNDLE_INVALID', (_name, bytes) => {
    expectCode(() => {
      decodeTransferBytes(bytes);
    }, 'TRANSFER_BUNDLE_INVALID');
  });

  it('合法 UTF-8 JSON—解码与解析通过—形状校验放行', () => {
    const text = JSON.stringify(validBundle);
    expect(decodeTransferBytes(encoder.encode(text))).toBe(text);
    expect(validateTransferBundleShape(parseTransferJson(text))).toEqual(validBundle);
    validateTransferReferences(validBundle);
  });

  it.each([
    ['非对象 JSON', '[]'],
    ['损坏 JSON', '{'],
  ])('JSON 解析—%s—TRANSFER_BUNDLE_INVALID', (_name, text) => {
    expectCode(() => {
      parseTransferJson(text);
    }, 'TRANSFER_BUNDLE_INVALID');
  });

  it('Schema 版本头—合法 semver 但非 1.0.0—TRANSFER_BUNDLE_UNSUPPORTED', () => {
    expectCode(() => {
      validateTransferBundleShape({ ...clone(validBundle), schema_version: '2.0.0' });
    }, 'TRANSFER_BUNDLE_UNSUPPORTED');
  });

  it.each([
    ['版本头非 semver', (bundle: TransferJson) => ({ ...bundle, schema_version: 'one' })],
    [
      '缺失顶层键',
      (bundle: TransferJson) => {
        delete mutable(bundle).story_bible;
        return bundle;
      },
    ],
    ['多余顶层键', (bundle: TransferJson) => ({ ...bundle, extra: 1 })],
    ['阶段输出数量 ≠ 4', (bundle: TransferJson) => ({ ...bundle, script_stage_outputs: [] })],
    ['bundle_id 不合规', (bundle: TransferJson) => ({ ...bundle, bundle_id: 'nope' })],
  ])('形状校验—%s—TRANSFER_BUNDLE_INVALID', (_name, mutate) => {
    expectCode(() => {
      validateTransferBundleShape(mutate(clone(validBundle)));
    }, 'TRANSFER_BUNDLE_INVALID');
  });

  it('Hash 校验—文件级 SHA-256 不匹配—TRANSFER_HASH_MISMATCH', () => {
    const text = JSON.stringify(validBundle);
    const hash = (value: string): string => (value === text ? 'a'.repeat(64) : 'b'.repeat(64));
    expect(() => {
      validateTransferHash(text, 'a'.repeat(64), hash);
    }).not.toThrow();
    expectCode(() => {
      validateTransferHash(text, '0'.repeat(64), hash);
    }, 'TRANSFER_HASH_MISMATCH');
  });

  it.each([
    [
      '项目归属不一致',
      (bundle: TransferJson) => {
        mutable(bundle.episode_storyboard).project_id = 'project_other';
      },
    ],
    [
      '圣经版本头与整集引用不一致',
      (bundle: TransferJson) => {
        mutable(bundle.episode_storyboard).story_bible_version_id = 'sbv_other';
      },
    ],
    [
      '阶段重复',
      (bundle: TransferJson) => {
        mutable((bundle.script_stage_outputs as unknown[])[1]).output = { stage: 'CONCEPT' };
      },
    ],
    [
      '阶段缺失',
      (bundle: TransferJson) => {
        mutable((bundle.script_stage_outputs as unknown[])[2]).output = { stage: 'CONCEPT' };
      },
    ],
    [
      'shot_id 重复',
      (bundle: TransferJson) => {
        mutable((mutable(bundle.episode_storyboard).shot_contracts as unknown[])[1]).shot_id =
          'shot_0001';
      },
    ],
    [
      'sequence 乱序',
      (bundle: TransferJson) => {
        mutable((mutable(bundle.episode_storyboard).shot_contracts as unknown[])[1]).sequence = 1;
      },
    ],
  ])('跨对象引用—%s—TRANSFER_REFERENCE_INVALID', (_name, mutate) => {
    const bundle = clone(validBundle);
    mutate(bundle);
    expectCode(() => {
      validateTransferReferences(bundle);
    }, 'TRANSFER_REFERENCE_INVALID');
  });

  it('空镜头集合—违反 minItems 形状约束—TRANSFER_BUNDLE_INVALID', () => {
    const bundle = clone(validBundle);
    mutable(bundle.episode_storyboard).shot_contracts = [];
    expectCode(() => {
      validateTransferReferences(bundle);
    }, 'TRANSFER_BUNDLE_INVALID');
  });
});

describe('确定性 ID Mapping 与文档重写（project-transfer-import-export 2.3）', () => {
  it('全量收集源 ID—按固定顺序生成映射—覆盖 project/episode/format/bible/阶段/镜头', () => {
    const sourceIds = collectTransferSourceIds(validBundle);
    expect(sourceIds.projectId).toBe('project_0001');
    expect(sourceIds.episodeId).toBe('episode_0001');
    expect(sourceIds.formatProfileId).toBe('format_0001');
    expect(sourceIds.storyBibleVersionId).toBe('sbv_0001');
    expect(sourceIds.scriptVersionIds).toEqual(['scv_c1', 'scv_o1', 'scv_b1', 'scv_s1']);
    expect(sourceIds.shotIds).toEqual(['shot_0001', 'shot_0002']);
    expect(sourceIds.shotVersionIds).toEqual(['scv_0001', 'scv_0002']);

    let counter = 0;
    const mapping = buildTransferIdMapping(
      sourceIds,
      (kind) => `${kind}_${String((counter += 1))}`,
    );
    // 生成顺序固定：project→episode→format→bible→4 阶段→镜头→镜头版本。
    expect(mapping.project_0001).toBe('project_project_1');
    expect(mapping.sbv_0001).toBe('sbv_storyBible_4');
    expect(mapping.scv_s1).toBe('scv_script_8');
    expect(mapping.shot_0002).toBe('shot_shot_10');
    expect(mapping.scv_0002).toBe('scv_shotVersion_12');
    expect(Object.keys(mapping)).toHaveLength(12);
  });

  it('整串相等才替换—嵌套文档全量重写—非 ID 字符串不受影响', () => {
    const sourceIds = collectTransferSourceIds(validBundle);
    const mapping = buildTransferIdMapping(sourceIds, () => 'x1');
    const rewritten = rewriteTransferReferences(validBundle, mapping);
    const storyboard = rewritten.episode_storyboard as TransferJson;
    expect(storyboard.project_id).toBe('project_x1');
    expect((storyboard.shot_contracts as unknown[])[0]).toMatchObject({
      shot_id: 'shot_x1',
      version_id: 'scv_x1',
    });
    // 非 ID 内容原样（整串相等策略，不做子串替换）。
    expect(storyboard.story_bible_version_id).toBe('sbv_x1');
    expect(validBundle.project_snapshot).toEqual({
      creation_mode: 'AI_ORIGINAL',
      dialogue_render_mode: 'NARRATION_FIRST',
      name: '雾都来信',
      project_id: 'project_0001',
    });
  });
});
