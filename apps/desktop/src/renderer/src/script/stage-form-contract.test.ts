import { describe, expect, it } from 'vitest';

import {
  findEditableSystemFields,
  createStableBusinessKey,
  parseAdvancedStageData,
  pointerToStageFieldId,
  serializeStageData,
  STAGE_FIELD_COVERAGE,
} from './stage-form-contract';

describe('五阶段结构化表单契约', () => {
  it('字段矩阵—覆盖五个 ScriptStageOutput data 形状且不包含系统元数据', () => {
    expect(Object.keys(STAGE_FIELD_COVERAGE)).toEqual([
      'CONCEPT',
      'STORY_BIBLE',
      'EPISODE_OUTLINE',
      'BEAT_SHEET',
      'SCENE_SCRIPT',
    ]);
    expect(STAGE_FIELD_COVERAGE.CONCEPT).toHaveLength(6);
    expect(STAGE_FIELD_COVERAGE.STORY_BIBLE).toHaveLength(9);
    expect(STAGE_FIELD_COVERAGE.EPISODE_OUTLINE).toHaveLength(6);
    expect(STAGE_FIELD_COVERAGE.BEAT_SHEET).toHaveLength(5);
    expect(STAGE_FIELD_COVERAGE.SCENE_SCRIPT).toHaveLength(9);
    expect(Object.values(STAGE_FIELD_COVERAGE).flat()).not.toContain('project_id');
  });

  it('表单数据进入高级编辑再返回—合法对象无损 round-trip—系统字段被拒绝', () => {
    const data = {
      core_conflict: '冲突',
      genre: '悬疑',
      synopsis: '故事梗概',
      target_audience: '青年',
      theme: '选择',
      title: '标题',
    };
    expect(parseAdvancedStageData(serializeStageData(data))).toEqual({ data, ok: true });
    expect(parseAdvancedStageData('{"project_id":"project_hidden"}')).toEqual({
      message: '不能编辑系统字段：project_id',
      ok: false,
    });
    expect(parseAdvancedStageData('{')).toEqual({
      message: '高级内容格式无效，请修正后再返回表单。',
      ok: false,
    });
  });

  it('重复项新增—按业务前缀生成稳定键—不复用已有键或数组位置', () => {
    expect(createStableBusinessKey('char', ['char_001', 'char_003'])).toBe('char_002');
    expect(createStableBusinessKey('script_scene', [])).toBe('script_scene_001');
  });

  it('JSON Pointer—角色键和数组下标稳定映射到中文控件字段', () => {
    expect(pointerToStageFieldId('/data/title')).toBe('title');
    expect(pointerToStageFieldId('/data/characters/char_lin/appearance')).toBe(
      'characters.*.appearance',
    );
    expect(pointerToStageFieldId('/data/scenes/0/spoken_lines/2/text')).toBe(
      'scenes.*.spoken_lines.*.text',
    );
    expect(pointerToStageFieldId('/project_id')).toBeNull();
  });

  it('高级 data—拒绝全部系统控制字段', () => {
    expect(
      findEditableSystemFields({
        project_id: 'project_hidden',
        schema_version: '1.0.0',
        status: 'READY',
        title: '可编辑标题',
      }),
    ).toEqual(['project_id', 'schema_version', 'status']);
    expect(findEditableSystemFields({ title: '可编辑标题' })).toEqual([]);
  });
});
