import { describe, expect, it } from 'vitest';

import { isProjectStage, listInvalidatedStages } from './script-dependency-graph';

describe('Script dependency graph', () => {
  it('条件—CONCEPT READY 变化—按固定顺序去重全部下游', () => {
    expect(listInvalidatedStages('CONCEPT')).toEqual([
      'STORY_BIBLE',
      'EPISODE_OUTLINE',
      'BEAT_SHEET',
      'SCENE_SCRIPT',
    ]);
  });

  it('条件—STORY_BIBLE READY 变化—只传播受影响集级阶段', () => {
    expect(listInvalidatedStages('STORY_BIBLE')).toEqual([
      'EPISODE_OUTLINE',
      'BEAT_SHEET',
      'SCENE_SCRIPT',
    ]);
  });

  it('条件—末阶段变化—没有下游且项目级判定固定', () => {
    expect(listInvalidatedStages('SCENE_SCRIPT')).toEqual([]);
    expect(isProjectStage('CONCEPT')).toBe(true);
    expect(isProjectStage('EPISODE_OUTLINE')).toBe(false);
  });
});
