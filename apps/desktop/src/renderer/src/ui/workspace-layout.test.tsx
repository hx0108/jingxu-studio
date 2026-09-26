import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AppShell, ComingSoonPanel, MORE_AREAS } from './AppShell';
import { StatusBadge, WorkspaceLayout } from './WorkspaceLayout';
import { WorkspaceTopbar } from './WorkspaceTopbar';
import { CreatorStageBar } from './CreatorStageBar';

describe('引导式工作台框架', () => {
  it('全局导航使用中文并标识当前位置', () => {
    const html = renderToStaticMarkup(
      <AppShell activeArea="workspace" onNavigate={vi.fn()} projectName="大富翁的每一天">
        <p>当前内容</p>
      </AppShell>,
    );
    for (const label of ['镜序', '我的作品', '质量评测', '设置', '更多', 'AI漫剧 / 短剧创作平台']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('大富翁的每一天');
    expect(html).not.toContain('JINGXU STUDIO');
    expect(html).not.toContain('生成任务');
    expect(MORE_AREAS).toStrictEqual([
      ['workspace', '创作工作台'],
      ['assets', '素材库'],
      ['tasks', '生成任务'],
      ['exports', '导出记录'],
    ]);
  });

  it('取消旧阶段侧栏，仅保留新原型主画布与右侧检查器', () => {
    const html = renderToStaticMarkup(
      <WorkspaceLayout inspector={<p>生成故事概念</p>}>
        <p>当前创作内容</p>
      </WorkspaceLayout>,
    );
    expect(html).not.toContain('workspace-flow');
    expect(html).toContain('workspace-canvas');
    expect(html).toContain('workspace-inspector');
    expect(html).toContain('当前创作内容');
    expect(html).toContain('生成故事概念');
    expect(html).not.toContain('准备状态');
    expect(html).not.toContain('版本与锁');
  });

  it('新原型顶部流程完整展示六步中文创作路径', () => {
    const html = renderToStaticMarkup(
      <CreatorStageBar
        activeStage="storyboard"
        onBack={vi.fn()}
        onOpenEvaluation={vi.fn()}
        onOpenHistory={vi.fn()}
        onOpenProjectSettings={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelect={vi.fn()}
        projectName="午后列车"
        workType="短剧"
      />,
    );
    for (const label of ['故事构思', '剧本完善', '分镜设计', '画面生成', '视频生成', '合成导出']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-current="step"');
    expect(html).not.toContain('六阶段创作流程');
  });

  it('项目顶栏只展示定位信息，不重复展示自动保存文案', () => {
    const html = renderToStaticMarkup(<WorkspaceTopbar area="剧本开发" context="大富翁的每一天" />);
    expect(html).toContain('创作工作台');
    expect(html).toContain('剧本开发');
    expect(html).toContain('大富翁的每一天');
    expect(html).not.toContain('项目进度自动保存');
    expect(html).not.toContain('最近保存于刚刚');
  });

  it('状态徽标展示中文而不是底层枚举', () => {
    const html = renderToStaticMarkup(<StatusBadge status="STALE_INPUT" />);
    expect(html).toContain('输入已变化');
    expect(html).not.toContain('STALE_INPUT');
  });

  it('未实现区域明确说明建设状态且不伪造数据', () => {
    const html = renderToStaticMarkup(
      <ComingSoonPanel description="独立素材库尚未实现。" title="素材库" />,
    );
    expect(html).toContain('独立素材库尚未实现');
    expect(html).toContain('不会生成或展示模拟业务数据');
  });
});
