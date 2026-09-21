import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { CreatorNextActionResultDto } from '@jingxu/contracts';

import { CreatorHome } from './CreatorHome';
import { routeForCreatorAction } from './creator-guide-api';

const action = {
  action: 'GENERATE_STAGE',
  blocked: false,
  fixAction: null,
  projectId: 'project_12345678',
  reason: '下一步生成单集大纲',
  stage: 'EPISODE_OUTLINE',
  target: 'SCRIPT',
  title: '生成单集大纲',
} as const satisfies CreatorNextActionResultDto;

describe('creator home', () => {
  it('起始选择—演示入口可见且标注免配置零费用—不出现工程概念', () => {
    const html = renderToStaticMarkup(
      <CreatorHome
        action={null}
        demoPending={false}
        error={null}
        onContinue={vi.fn()}
        onCreate={vi.fn()}
        onDemo={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        showStartChoice
      />,
    );
    expect(html).toContain('5 分钟体验（免配置·零费用）');
    for (const forbidden of ['JSON', 'Provider', 'requestId']) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('已有作品—首页展示当前一步—只有一个主操作且不暴露工程概念', () => {
    const html = renderToStaticMarkup(
      <CreatorHome
        action={action}
        demoPending={false}
        error={null}
        onContinue={vi.fn()}
        onCreate={vi.fn()}
        onDemo={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        showStartChoice={false}
      />,
    );

    expect(html).toContain('继续制作本集');
    expect(html).toContain('生成单集大纲');
    expect(html.match(/data-primary-action/g) ?? []).toHaveLength(1);
    for (const forbidden of ['JSON', 'Provider', '版本', '能力快照', '任务 ID', '哈希']) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('业务目标—路由映射—直接定位阶段或媒体工作区', () => {
    expect(routeForCreatorAction(action)).toEqual({
      mediaStep: null,
      screen: 'script',
      stage: 'EPISODE_OUTLINE',
    });
    expect(
      routeForCreatorAction({
        ...action,
        action: 'ENTER_STORY',
        stage: null,
        target: 'SOURCE_INPUT',
      }),
    ).toEqual({ mediaStep: null, screen: 'script', stage: 'CONCEPT' });
    expect(
      routeForCreatorAction({
        ...action,
        action: 'GENERATE_IMAGES',
        stage: 'SHOT_CONTRACT',
        target: 'IMAGE',
      }),
    ).toEqual({ mediaStep: 'image', screen: 'script', stage: 'SCENE_SCRIPT' });
    expect(
      routeForCreatorAction({ ...action, action: 'ADD_REFERENCES', target: 'ASSETS' }),
    ).toEqual({ mediaStep: null, screen: 'assets', stage: 'SCENE_SCRIPT' });
  });
});
