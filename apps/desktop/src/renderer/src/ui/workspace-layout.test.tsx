import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AppShell, ComingSoonPanel } from './AppShell';
import { StatusBadge, WorkspaceLayout } from './WorkspaceLayout';

describe('引导式工作台框架', () => {
  it('全局导航使用中文并标识当前位置', () => {
    const html = renderToStaticMarkup(
      <AppShell activeArea="workspace" onNavigate={vi.fn()} projectName="大富翁的每一天">
        <p>当前内容</p>
      </AppShell>,
    );
    for (const label of [
      '首页',
      '我的项目',
      '创作工作台',
      '素材库',
      '生成任务',
      '导出记录',
      '质量与评测',
      '设置',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('大富翁的每一天');
    expect(html).not.toContain('JINGXU STUDIO');
  });

  it('三栏布局保留流程、创作区与渐进式检查器', () => {
    const html = renderToStaticMarkup(
      <WorkspaceLayout flow={<p>六阶段流程</p>} inspector={<p>版本与锁</p>}>
        <p>当前创作内容</p>
      </WorkspaceLayout>,
    );
    expect(html).toContain('workspace-flow');
    expect(html).toContain('workspace-canvas');
    expect(html).toContain('workspace-inspector');
    expect(html).toContain('<summary>上下文与高级信息</summary>');
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
