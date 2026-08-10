import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import type { ProjectListResultDto, ProjectSummaryDto } from '@jingxu/contracts';

import { projectKeys } from './lib/query-client';
import { useProjectUiStore, type ProjectUiState } from './store/project-ui-store';

/**
 * §8.1 职责划分证据（Design §8 line 178-180、line 215）。
 * 三个 store 各司其职、互不复制事实：
 *   - React Query：Project list/get 服务端事实缓存
 *   - React Hook Form：创作设定字段 / 字段错误 / 提交状态
 *   - Zustand：仅选中 projectId + 列表 scope/filter + dirty 协调，不复制 Project/FormatProfile
 * 测试运行于 node 环境（root vitest.config environment:'node'），故组件断言一律走
 * renderToStaticMarkup，不依赖 DOM/refs。
 */
const SUMMARY: ProjectSummaryDto = {
  id: 'proj-aaaaaaaa',
  name: '我的漫画',
  genre: null,
  style: null,
  creationMode: 'AI_ORIGINAL',
  dialogueRenderMode: 'NARRATION_FIRST',
  aspectRatio: '9:16',
  updatedAt: '2026-08-09T10:00:00+08:00',
  deletedAt: null,
};
const LIST_RESULT: ProjectListResultDto = {
  items: [SUMMARY],
  nextCursor: null,
  truncated: false,
};

/** 读取 React Query 缓存作为 Project 列表事实源的组件。 */
const ProjectListFromCache = () => {
  const { data } = useQuery({
    queryKey: projectKeys.list('ACTIVE', ''),
    queryFn: () => LIST_RESULT,
  });
  return (
    <ul>
      {(data?.items ?? []).map((p) => (
        <li key={p.id}>{p.name}</li>
      ))}
    </ul>
  );
};

interface SettingFormValues {
  name: string;
  genre: string;
}

/** 由 React Hook Form 持有创作设定表单状态的组件。 */
const SettingForm = () => {
  const { getValues } = useForm<SettingFormValues>({
    defaultValues: { name: '草稿漫画', genre: '' },
  });
  return (
    <form>
      <output>{getValues('name')}</output>
    </form>
  );
};

describe('Renderer 状态职责划分（§8.1，Design §8）', () => {
  test('React Query 缓存是 Project 列表事实源：预置缓存后 useQuery 同步渲染出项目名', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(projectKeys.list('ACTIVE', ''), LIST_RESULT);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ProjectListFromCache />
      </QueryClientProvider>,
    );

    expect(html).toContain('我的漫画');
  });

  test('React Hook Form 持有创作设定表单状态：defaultValues 立即可经 getValues 读出', () => {
    const html = renderToStaticMarkup(<SettingForm />);

    expect(html).toContain('草稿漫画');
  });

  test('Zustand 仅持有 UI 协调字段，不复制 Project/FormatProfile 事实', () => {
    const state = useProjectUiStore.getState();
    const dataKeys = Object.keys(state).filter(
      (k) => typeof state[k as keyof typeof state] !== 'function',
    );

    // 仅这四个协调字段，无 Project/FormatProfile 数据字段
    expect(dataKeys.sort()).toEqual(['isDirty', 'listFilter', 'listScope', 'selectedProjectId']);

    // 任一字段都非承载事实的对象/数组（selectedProjectId 为 string|null，余为标量）
    for (const k of dataKeys) {
      const value = state[k as keyof typeof state];
      expect(value === null || typeof value !== 'object').toBe(true);
    }

    // 编译期守卫：ProjectUiState 形状不接受 Project 事实字段（Design line 215）
    // @ts-expect-error currentProject 不在 ProjectUiState，禁止把 Project 事实复制进 store
    const _noProjectFact: ProjectUiState = { ...state, currentProject: SUMMARY };
    void _noProjectFact;
  });
});
