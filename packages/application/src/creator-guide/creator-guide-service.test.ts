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

describe('startDemo（3.1 演示初始化·应用层语义）', () => {
  const noopQuery: CreatorGuideQueryPort = {
    getProjectSnapshot: () => Promise.resolve(null),
    listActiveProjects: () => Promise.resolve([]),
  };

  it('种子成功—原样透传结果且 resued/项目 id 保持种子事实', async () => {
    const seeds: readonly string[] = [];
    const seeder = {
      seed: (requestId: string) => {
        (seeds as string[]).push(requestId);
        return Promise.resolve({
          ok: true,
          data: {
            isDemo: true,
            projectId: 'project_demo0001',
            resumed: false,
            summary: '示例已就绪',
          },
        } as const);
      },
    };
    const result = await createCreatorGuideService(noopQuery, seeder).startDemo(
      { requestId: 'request_demo0001' },
      'trace_demo01',
    );
    expect(result).toMatchObject({
      ok: true,
      data: { isDemo: true, projectId: 'project_demo0001', resumed: false },
    });
    expect(seeds).toEqual(['request_demo0001']);
  });

  it('同 requestId 再次进入—幂等归种子执行口—服务层透传 resumed 事实', async () => {
    // 幂等由 SeederPort 以回执保证（组合根实现）；服务层契约是原样透传，不复制项目。
    const seeder = {
      seed: (requestId: string) =>
        Promise.resolve({
          ok: true,
          data: {
            isDemo: true,
            projectId: 'project_demo0001',
            resumed: requestId === 'request_demo0001' && seedsSeen.size > 0,
            summary: '示例已就绪',
          },
        } as const),
    };
    const seedsSeen = new Set<string>();
    const trackingSeeder = {
      seed: (requestId: string) => {
        const resumed = seedsSeen.has(requestId);
        seedsSeen.add(requestId);
        return seeder.seed(requestId).then((result) => ({
          ...result,
          data: { ...result.data, resumed },
        }));
      },
    };
    const service = createCreatorGuideService(noopQuery, trackingSeeder);
    const first = await service.startDemo({ requestId: 'request_demo0001' }, 'trace_demo02');
    const second = await service.startDemo({ requestId: 'request_demo0001' }, 'trace_demo03');
    expect(first).toMatchObject({ ok: true, data: { resumed: false } });
    expect(second).toMatchObject({
      ok: true,
      data: { resumed: true, projectId: 'project_demo0001' },
    });
  });

  it('种子失败—映射 DEMO_INITIALIZATION_FAILED 并保留种子的可重试语义', async () => {
    const seeder = {
      seed: () =>
        Promise.resolve({
          ok: false,
          error: {
            code: 'DEMO_INITIALIZATION_FAILED',
            fieldErrors: null,
            message: '示例创建未完成',
            retryable: true,
            traceId: 'trace_seed_inner',
            userAction: '重试即可；不会留下半成品。',
          },
        } as const),
    };
    const result = await createCreatorGuideService(noopQuery, seeder).startDemo(
      { requestId: 'request_demo0002' },
      'trace_demo04',
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'DEMO_INITIALIZATION_FAILED', retryable: true },
    });
  });

  it('未注入种子执行口—稳定失败不抛异常—体验入口可安全降级', async () => {
    const result = await createCreatorGuideService(noopQuery).startDemo(
      { requestId: 'request_demo0003' },
      'trace_demo05',
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'DEMO_INITIALIZATION_FAILED', retryable: true },
    });
  });
});
