import { create } from 'zustand';

import type { ProjectListScope } from '@jingxu/contracts';

/**
 * Renderer UI 协调状态（Design §8 line 180）。
 *
 * 仅保存四类协调事实：选中 projectId、列表 scope、列表 filter、dirty 离开协调标志。
 * 严禁复制 Project / FormatProfile 数据——它们的唯一事实源是 React Query 缓存
 * （Design line 215「禁止把同一事实复制进多个 store」）。isDirty 只是 RHF dirty 状态的
 * 布尔镜像，供 §8.5 离开保护经白名单通知 Main 使用，不承载任何创作设定字段值。
 */
export interface ProjectUiState {
  selectedProjectId: string | null;
  listScope: ProjectListScope;
  listFilter: string;
  /** 创作设定是否存在未提交编辑（RHF dirty 的布尔镜像，非字段值副本）。 */
  isDirty: boolean;
  select: (id: string | null) => void;
  setListScope: (scope: ProjectListScope) => void;
  setListFilter: (filter: string) => void;
  setDirty: (dirty: boolean) => void;
}

export const useProjectUiStore = create<ProjectUiState>()((set) => ({
  selectedProjectId: null,
  listScope: 'ACTIVE',
  listFilter: '',
  isDirty: false,
  select: (selectedProjectId) => {
    set({ selectedProjectId });
  },
  setListScope: (listScope) => {
    set({ listScope });
  },
  setListFilter: (listFilter) => {
    set({ listFilter });
  },
  setDirty: (isDirty) => {
    set({ isDirty });
  },
}));
