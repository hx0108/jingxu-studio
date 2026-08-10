import { QueryClient } from '@tanstack/react-query';

import type { ProjectListScope } from '@jingxu/contracts';

/**
 * Project 查询键命名空间。scope（ACTIVE/DELETED）+ filter 进入列表 key，保证活动列表与
 * 回收站各自独立缓存、筛选条件变化即换 key（Design §7 keyset + §8 React Query 事实缓存）。
 * detail key 以 projectId 为尾段，便于 mutation 成功后精确失效单条（§8.4）。
 */
const PROJECTS = ['projects'] as const;

export const projectKeys = {
  all: PROJECTS,
  list: (scope: ProjectListScope, filter: string) => [...PROJECTS, 'list', scope, filter] as const,
  detail: (id: string) => [...PROJECTS, 'detail', id] as const,
};

/**
 * 单用户本地工作台的 QueryClient 默认值：关闭 window focus refetch 噪音；transient 错误
 * 单次重试（AppError.retryable=true 的场景由 mutation/hook 自行决定是否再触发，见 §8.4）；
 * staleTime 0 使精确 invalidation 后立即可重拉。mutations 默认不自动重试（提交由用户驱动）。
 */
export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 0 },
      mutations: { retry: 0 },
    },
  });
