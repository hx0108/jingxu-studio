import { describe, expect, it } from 'vitest';

import {
  creatorDemoResultSchema,
  creatorNextActionResultSchema,
  creatorPreparationResultSchema,
  getCreatorNextActionInputSchema,
  getCreatorPreparationInputSchema,
  startCreatorDemoInputSchema,
} from './creator-guide-api';

const projectId = 'project_guide0001';

describe('CreatorGuide DTO Contract', () => {
  it('下一步输入与结果—只接受严格的业务动作字段', () => {
    expect(getCreatorNextActionInputSchema.safeParse({ projectId: null }).success).toBe(true);
    expect(
      getCreatorNextActionInputSchema.safeParse({ projectId: null, provider: 'secret' }).success,
    ).toBe(false);
    expect(
      creatorNextActionResultSchema.safeParse({
        action: 'ADD_REFERENCES',
        blocked: true,
        fixAction: 'ADD_STYLE_REFERENCE',
        projectId,
        reason: '缺少画风参考图',
        stage: 'SHOT_CONTRACT',
        target: 'ASSETS',
        title: '补充画风参考',
      }).success,
    ).toBe(true);
  });

  it('准备结果—BLOCK 与 canProceed 一致且拒绝敏感附加字段', () => {
    const fixture = {
      canProceed: false,
      cost: { currency: null, effectiveAt: null, max: null, min: null, status: 'UNKNOWN' },
      estimatedDurationSec: 60,
      isDemo: false,
      items: [
        {
          code: 'CHARACTER_REFERENCE_REQUIRED',
          detail: '角色林岚缺少参考图',
          fixAction: 'ADD_CHARACTER_REFERENCE',
          label: '角色参考图',
          status: 'BLOCK',
        },
      ],
      operation: 'IMAGE',
      preparationRevision: 'prep_guide0001',
      projectId,
      shotIds: ['shot_guide0001'],
    } as const;
    expect(creatorPreparationResultSchema.safeParse(fixture).success).toBe(true);
    expect(
      creatorPreparationResultSchema.safeParse({ ...fixture, apiKey: 'must-not-cross-ipc' })
        .success,
    ).toBe(false);
    expect(creatorPreparationResultSchema.safeParse({ ...fixture, canProceed: true }).success).toBe(
      false,
    );
  });

  it('准备输入—限制操作、范围和未知字段', () => {
    expect(
      getCreatorPreparationInputSchema.safeParse({
        episodeId: 'episode_guide0001',
        operation: 'VIDEO',
        projectId,
        shotIds: ['shot_guide0001'],
      }).success,
    ).toBe(true);
    expect(
      getCreatorPreparationInputSchema.safeParse({
        episodeId: null,
        operation: 'MODEL_ROUTE',
        projectId,
        shotIds: [],
      }).success,
    ).toBe(false);
  });

  it('演示初始化—只接受 requestId 且结果持续标记 demo', () => {
    expect(startCreatorDemoInputSchema.safeParse({ requestId: 'demo_req_0001' }).success).toBe(
      true,
    );
    expect(
      creatorDemoResultSchema.safeParse({
        isDemo: true,
        projectId,
        resumed: false,
        summary: '演示项目已准备完成，不会产生真实费用',
      }).success,
    ).toBe(true);
  });
});
