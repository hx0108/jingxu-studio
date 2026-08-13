import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { AppErrorDto, ProjectDetailDto, ProjectSummaryDto } from '@jingxu/contracts';

import { DirtyLeaveDialog } from './DirtyLeaveDialog';
import { ProjectDetailView } from './ProjectDetail';
import { ProjectFormView, createProjectFormDefaults } from './ProjectForm';
import { ProjectListView } from './ProjectList';
import { describeProjectError } from './project-error';

const PROJECT: ProjectSummaryDto = {
  id: 'project_000001',
  name: '雨夜回声',
  genre: '悬疑',
  style: '电影感',
  creationMode: 'AI_ORIGINAL',
  dialogueRenderMode: 'NARRATION_FIRST',
  aspectRatio: '9:16',
  updatedAt: '2026-08-09T12:00:00.000Z',
  deletedAt: null,
};

const DETAIL: ProjectDetailDto = {
  ...PROJECT,
  deploymentMode: 'LOCAL_DEMO',
  createdAt: '2026-08-09T11:00:00.000Z',
  currentFormatProfile: {
    id: 'format_000001',
    projectId: PROJECT.id,
    versionNo: 2,
    parentId: 'format_000000',
    aspectRatio: '9:16',
    width: 1080,
    height: 1920,
    fps: 30,
    language: 'zh-CN',
    subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
    isCurrent: true,
    createdAt: '2026-08-09T12:00:00.000Z',
  },
  formatProfileHistory: [
    {
      id: 'format_000000',
      projectId: PROJECT.id,
      versionNo: 1,
      parentId: null,
      aspectRatio: '16:9',
      width: 1920,
      height: 1080,
      fps: 30,
      language: 'zh-CN',
      subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
      isCurrent: false,
      createdAt: '2026-08-09T11:00:00.000Z',
    },
  ],
};

describe('ProjectListView — §8.2 完整页面状态', () => {
  it.each([
    ['启动加载', { state: 'loading' as const }, '正在加载项目'],
    ['真实空态', { state: 'ready' as const, projects: [], hasFilter: false }, '创建第一个项目'],
    ['筛选无结果', { state: 'ready' as const, projects: [], hasFilter: true }, '没有匹配的项目'],
    ['活动列表', { state: 'ready' as const, projects: [PROJECT], hasFilter: false }, '雨夜回声'],
    [
      '分页加载',
      { state: 'ready' as const, projects: [PROJECT], hasFilter: false, loadingMore: true },
      '正在加载更多',
    ],
    [
      '回收站',
      {
        state: 'ready' as const,
        projects: [{ ...PROJECT, deletedAt: '2026-08-10T00:00:00.000Z' }],
        hasFilter: false,
        scope: 'DELETED' as const,
      },
      '恢复项目',
    ],
    ['查询错误', { state: 'error' as const, errorMessage: '加载失败，请重试' }, '加载失败，请重试'],
  ])('%s 可观察', (_name, props, expected) => {
    const html = renderToStaticMarkup(
      <ProjectListView
        hasMore={false}
        onCreate={vi.fn()}
        onLoadMore={vi.fn()}
        onOpen={vi.fn()}
        onRestore={vi.fn()}
        {...props}
      />,
    );
    expect(html).toContain(expected);
  });

  it('真实空态只有一个主操作', () => {
    const html = renderToStaticMarkup(
      <ProjectListView
        hasFilter={false}
        hasMore={false}
        onCreate={vi.fn()}
        onLoadMore={vi.fn()}
        onOpen={vi.fn()}
        onRestore={vi.fn()}
        projects={[]}
        state="ready"
      />,
    );
    expect(html.match(/data-primary-action/g) ?? []).toHaveLength(1);
  });
});

describe('ProjectFormView — §8.3 创作设定', () => {
  it('默认值固定为 9:16、NARRATION_FIRST 和 5-5-12-5', () => {
    expect(createProjectFormDefaults()).toStrictEqual({
      name: '',
      genre: '',
      style: '',
      creationMode: 'AI_ORIGINAL',
      dialogueRenderMode: 'NARRATION_FIRST',
      aspectRatio: '9:16',
      subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
    });
  });

  it('画幅和四种对白模式均为键盘可选控件，系统字段不在表单中', () => {
    const html = renderToStaticMarkup(
      <ProjectFormView
        defaults={createProjectFormDefaults()}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(html).toContain('value="16:9"');
    for (const mode of ['NARRATION_FIRST', 'WEAK_LIP_SYNC', 'PRECISE_LIP_SYNC', 'SUBTITLE_ONLY'])
      expect(html).toContain(`value="${mode}"`);
    for (const forbidden of [
      'name="width"',
      'name="height"',
      'name="fps"',
      'name="language"',
      'name="path"',
    ])
      expect(html).not.toContain(forbidden);
  });
});

describe('ProjectDetailView — §8.5 详情与后续入口', () => {
  it('展示 current/history、已开放剧本入口与禁用分镜入口', () => {
    const html = renderToStaticMarkup(
      <ProjectDetailView detail={DETAIL} onDelete={vi.fn()} onEdit={vi.fn()} onRestore={vi.fn()} />,
    );
    expect(html).toContain('当前版本 v2');
    expect(html).toContain('历史版本 v1');
    expect(html).toContain('进入剧本工作区');
    expect(html).toContain('分镜工作台');
    expect((html.match(/disabled=""/g) ?? []).length).toBe(1);
    expect(html).toContain('将在后续 Change 实现');
  });
});

describe('删除、恢复、错误和 dirty 可访问交互 — §8.6–§8.8', () => {
  it('DirtyLeaveDialog 提供三选项、dialog 语义和初始焦点', () => {
    const html = renderToStaticMarkup(
      <DirtyLeaveDialog
        onCancel={vi.fn()}
        onDiscard={vi.fn()}
        onSaveAndLeave={vi.fn()}
        open
        pending={false}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('保存并离开');
    expect(html).toContain('放弃修改');
    expect(html).toContain('取消');
    expect(html).toContain('autofocus=""');
  });

  it('稳定错误码映射用户动作且不显示内部 message', () => {
    const error: AppErrorDto = {
      code: 'FORMAT_PROFILE_DEPENDENCY_BLOCKED',
      message: 'C:\\secret\\db.sqlite SELECT *',
      retryable: false,
      userAction: null,
      fieldErrors: null,
      traceId: 'trace_000001',
    };
    const view = describeProjectError(error);
    expect(view.summary).toContain('已有分镜引用');
    expect(view.nextAction).toContain('保持当前画幅');
    expect(JSON.stringify(view)).not.toContain('secret');
    expect(view.traceId).toBe('trace_000001');
  });
});
