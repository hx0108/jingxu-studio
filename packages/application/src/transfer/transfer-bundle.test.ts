import { describe, expect, it } from 'vitest';

import { assembleTransferBundle, stableTransferJson } from './transfer-bundle';

const storyboardInput = {
  episode_id: 'episode_0001',
  format_profile: {
    aspect_ratio: '9:16',
    fps: 30,
    height: 1920,
    id: 'format_0001',
    language: 'zh-CN',
    subtitle_safe_area: { bottom_pct: 12, left_pct: 5, right_pct: 5, top_pct: 5 },
    width: 1080,
  },
  project_id: 'project_0001',
  shot_contracts: [{ continuity: {}, shot_id: 'shot_0001', version_id: 'scv_0001' }],
} as const;

const assemblyInput = {
  bundleId: 'bundle_transfer_001',
  episodeStoryboard: storyboardInput,
  exportedAt: '2026-08-21T10:00:00+08:00',
  projectSnapshot: {
    creationMode: 'AI_ORIGINAL',
    dialogueRenderMode: 'NARRATION_FIRST',
    genre: '悬疑',
    name: '雾都来信',
    projectId: 'project_0001',
  },
  scriptStageOutputs: [
    { output: { stage: 'CONCEPT' }, versionId: 'scv_c1' },
    { output: { stage: 'EPISODE_OUTLINE' }, versionId: 'scv_o1' },
    { output: { stage: 'BEAT_SHEET' }, versionId: 'scv_b1' },
    { output: { stage: 'SCENE_SCRIPT' }, versionId: 'scv_s1' },
  ],
  storyBible: { output: { stage: 'STORY_BIBLE' }, versionId: 'sbv_1' },
};

describe('assembleTransferBundle（project-transfer-import-export 2.1/2.2）', () => {
  it('组装 CURRENT_ONLY 快照—顶层恒为 Schema 七键—project_snapshot 只保留公开四字段', () => {
    const result = assembleTransferBundle(assemblyInput);
    expect(Object.keys(result.bundle).sort()).toEqual([
      'bundle_id',
      'episode_storyboard',
      'exported_at',
      'project_snapshot',
      'schema_version',
      'script_stage_outputs',
      'story_bible',
    ]);
    expect(result.bundle.schema_version).toBe('1.0.0');
    // genre/style 等内部字段不进入公开交换契约。
    expect(JSON.stringify(result.bundle.project_snapshot)).not.toContain('genre');
    expect(result.bundle.project_snapshot).toEqual({
      creation_mode: 'AI_ORIGINAL',
      dialogue_render_mode: 'NARRATION_FIRST',
      name: '雾都来信',
      project_id: 'project_0001',
    });
    expect(result.warningCodes).toEqual(['TRANSFER_CURRENT_ONLY']);
  });

  it('分镜引用媒体资产—结构引用保留但不打包字节—返回媒体未打包警告', () => {
    const result = assembleTransferBundle({
      ...assemblyInput,
      episodeStoryboard: {
        ...storyboardInput,
        shot_contracts: [
          {
            continuity: { asset_version_ids: ['assetv_0001'] },
            shot_id: 'shot_0001',
            version_id: 'scv_0001',
          },
        ],
      },
    });
    expect(result.warningCodes).toContain('TRANSFER_MEDIA_NOT_PACKAGED');
    // 引用本身仍在（缺失语义由警告表达，不由删改数据表达）。
    expect(JSON.stringify(result.bundle.episode_storyboard)).toContain('assetv_0001');
  });

  it('稳定序列化—键序无关—同内容不同键序产出相同字节与哈希', () => {
    const first = stableTransferJson({ a: 1, nested: { z: true, b: [2, { y: 1, x: 2 }] } });
    const second = stableTransferJson({ nested: { b: [2, { x: 2, y: 1 }], z: true }, a: 1 });
    expect(first).toBe(second);
    expect(first).toBe('{"a":1,"nested":{"b":[2,{"x":2,"y":1}],"z":true}}');
  });
});
