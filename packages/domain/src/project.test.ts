import { describe, expect, it } from 'vitest';

import {
  CREATION_MODES,
  DEFAULT_CREATION_MODE,
  DEFAULT_DIALOGUE_RENDER_MODE,
  DEPLOYMENT_MODES,
  DIALOGUE_RENDER_MODES,
} from './project';

describe('Project 领域枚举', () => {
  it('CreationMode—与 0001 projects 表 CHECK 对齐', () => {
    expect(CREATION_MODES).toStrictEqual([
      'AI_ORIGINAL',
      'AUTHORIZED_ADAPTATION',
      'AI_OPTIMIZATION',
    ]);
  });

  it('DialogueRenderMode—四个值与 0001 对齐', () => {
    expect(DIALOGUE_RENDER_MODES).toStrictEqual([
      'NARRATION_FIRST',
      'WEAK_LIP_SYNC',
      'PRECISE_LIP_SYNC',
      'SUBTITLE_ONLY',
    ]);
  });

  it('DeploymentMode—与 0001 对齐', () => {
    expect(DEPLOYMENT_MODES).toStrictEqual(['LOCAL_DEMO', 'CONTROLLED_EXTERNAL_TEST']);
  });

  it('默认值—AI_ORIGINAL 与 NARRATION_FIRST', () => {
    expect(DEFAULT_CREATION_MODE).toBe('AI_ORIGINAL');
    expect(DEFAULT_DIALOGUE_RENDER_MODE).toBe('NARRATION_FIRST');
  });
});
