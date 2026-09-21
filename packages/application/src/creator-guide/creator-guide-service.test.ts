import { describe, expect, it } from 'vitest';

import { createCreatorGuideService, resolveCreatorNextAction } from './creator-guide-service';

import type {
  CreatorGuideProjectSnapshot,
  CreatorGuideQueryPort,
  CreatorStageStatus,
} from '../ports/creator-guide';

const readyStages = (): Record<
  keyof CreatorGuideProjectSnapshot['stages'],
  CreatorStageStatus
> => ({
  BEAT_SHEET: 'READY',
  CONCEPT: 'READY',
  EPISODE_OUTLINE: 'READY',
  SCENE_SCRIPT: 'READY',
  SHOT_CONTRACT: 'READY',
  STORY_BIBLE: 'READY',
});

const snapshot = (
  overrides: Partial<CreatorGuideProjectSnapshot> = {},
): CreatorGuideProjectSnapshot => ({
  consistencyBlocks: [],
  exportReady: true,
  imagesReady: true,
  projectId: 'project_guide0001',
  sourceInputReady: true,
  stages: readyStages(),
  videosReady: true,
  voiceReady: true,
  ...overrides,
});

describe('CreatorGuideService.getNextAction 决策表', () => {
  it.each([
    ['输入故事', snapshot({ sourceInputReady: false }), 'ENTER_STORY', 'SOURCE_INPUT'],
    [
      '生成概念',
      snapshot({ stages: { ...readyStages(), CONCEPT: 'MISSING' } }),
      'GENERATE_STAGE',
      'SCRIPT',
    ],
    [
      '确认概念草稿',
      snapshot({ stages: { ...readyStages(), CONCEPT: 'DRAFT' } }),
      'REVIEW_STAGE',
      'SCRIPT',
    ],
    [
      '更新过期故事设定',
      snapshot({ stages: { ...readyStages(), STORY_BIBLE: 'STALE_INPUT' } }),
      'GENERATE_STAGE',
      'SCRIPT',
    ],
    [
      '生成分镜',
      snapshot({ stages: { ...readyStages(), SHOT_CONTRACT: 'MISSING' } }),
      'GENERATE_STORYBOARD',
      'STORYBOARD',
    ],
    [
      '确认分镜',
      snapshot({ stages: { ...readyStages(), SHOT_CONTRACT: 'DRAFT' } }),
      'REVIEW_STORYBOARD',
      'STORYBOARD',
    ],
    ['补画风图', snapshot({ consistencyBlocks: ['STYLE_REFERENCE'] }), 'ADD_REFERENCES', 'ASSETS'],
    [
      '补角色图',
      snapshot({ consistencyBlocks: ['CHARACTER_REFERENCE'] }),
      'ADD_REFERENCES',
      'ASSETS',
    ],
    ['生成图片', snapshot({ imagesReady: false }), 'GENERATE_IMAGES', 'IMAGE'],
    ['生成视频', snapshot({ videosReady: false }), 'GENERATE_VIDEOS', 'VIDEO'],
    ['生成配音', snapshot({ voiceReady: false }), 'GENERATE_VOICE', 'VOICE'],
    ['准备导出', snapshot({ exportReady: false }), 'PREPARE_EXPORT', 'EXPORT'],
    ['查看成片', snapshot(), 'VIEW_RESULT', 'COMPLETED'],
  ])('%s—返回唯一稳定动作', (_name, input, action, target) => {
    expect(resolveCreatorNextAction(input)).toMatchObject({ action, target });
  });

  it('无项目—返回起始选择且不要求生成服务配置', async () => {
    const query: CreatorGuideQueryPort = {
      getProjectSnapshot: () => Promise.resolve(null),
      listActiveProjects: () => Promise.resolve([]),
    };
    await expect(
      createCreatorGuideService(query).getNextAction({ projectId: null }, 'trace_guide01'),
    ).resolves.toMatchObject({ ok: true, data: { action: 'CHOOSE_START', target: 'START' } });
  });

  it('多项目—按 updatedAt 降序且同时间 id 升序稳定选择', async () => {
    const requested: string[] = [];
    const query: CreatorGuideQueryPort = {
      getProjectSnapshot: (projectId) => {
        requested.push(projectId);
        return Promise.resolve(snapshot({ projectId }));
      },
      listActiveProjects: () =>
        Promise.resolve([
          { id: 'project_zeta0001', updatedAt: '2026-09-20T10:00:00.000Z' },
          { id: 'project_beta0001', updatedAt: '2026-09-21T10:00:00.000Z' },
          { id: 'project_alpha001', updatedAt: '2026-09-21T10:00:00.000Z' },
        ]),
    };
    await createCreatorGuideService(query).getNextAction({ projectId: null }, 'trace_guide02');
    expect(requested).toEqual(['project_alpha001']);
  });

  it('显式项目不存在—稳定错误且不读工作区', async () => {
    let reads = 0;
    const query: CreatorGuideQueryPort = {
      getProjectSnapshot: () => {
        reads += 1;
        return Promise.resolve(null);
      },
      listActiveProjects: () =>
        Promise.resolve([{ id: 'project_guide0001', updatedAt: '2026-09-21T10:00:00.000Z' }]),
    };
    const result = await createCreatorGuideService(query).getNextAction(
      { projectId: 'project_missing01' },
      'trace_guide03',
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'CREATOR_GUIDE_PROJECT_NOT_FOUND' },
    });
    expect(reads).toBe(0);
  });

  it('读取期间项目状态变化—返回可重试 scope stale', async () => {
    const query: CreatorGuideQueryPort = {
      getProjectSnapshot: () => Promise.resolve(null),
      listActiveProjects: () =>
        Promise.resolve([{ id: 'project_guide0001', updatedAt: '2026-09-21T10:00:00.000Z' }]),
    };
    await expect(
      createCreatorGuideService(query).getNextAction(
        { projectId: 'project_guide0001' },
        'trace_guide04',
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'CREATOR_GUIDE_SCOPE_STALE' } });
  });
});
