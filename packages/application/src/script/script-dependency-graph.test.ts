import { describe, expect, it } from 'vitest';

import { isProjectStage, listInvalidatedStages } from './script-dependency-graph';

describe('Script dependency graph', () => {
  it('条件—CONCEPT READY 变化—按固定顺序去重全部下游', () => {
    expect(listInvalidatedStages('CONCEPT')).toEqual([
      'STORY_BIBLE',
      'EPISODE_OUTLINE',
      'BEAT_SHEET',
      'SCENE_SCRIPT',
      'SHOT_CONTRACT',
    ]);
  });

  it('条件—STORY_BIBLE READY 变化—只传播受影响集级阶段', () => {
    expect(listInvalidatedStages('STORY_BIBLE')).toEqual([
      'EPISODE_OUTLINE',
      'BEAT_SHEET',
      'SCENE_SCRIPT',
      'SHOT_CONTRACT',
    ]);
  });

  it('条件—EPISODE_OUTLINE READY 变化—BEAT_SHEET 传递链与分镜整集', () => {
    expect(listInvalidatedStages('EPISODE_OUTLINE')).toEqual([
      'BEAT_SHEET',
      'SCENE_SCRIPT',
      'SHOT_CONTRACT',
    ]);
  });

  it('条件—末阶段变化—分镜整集跟随失效，SHOT_CONTRACT 自身无下游', () => {
    expect(listInvalidatedStages('SCENE_SCRIPT')).toEqual(['SHOT_CONTRACT']);
    expect(isProjectStage('CONCEPT')).toBe(true);
    expect(isProjectStage('EPISODE_OUTLINE')).toBe(false);
    // 分镜为集级阶段：项目级判定恒 false（SHOT_CONTRACT 失效走 episode 级 head）。
    expect(isProjectStage('SHOT_CONTRACT')).toBe(false);
  });
});
