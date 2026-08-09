/**
 * 内存 Fake Ports 与依赖（test-only infra）。
 *
 * 为 ProjectService Unit 测试提供确定性、可种子的内存实现。keyset 排序与 scope 过滤
 * 是真实算法的简化镜像（`updated_at DESC, id DESC`），使分页行为可独立于 SQLite 验证。
 * §3.1 仅 list/get 路径被覆盖；写命令相关方法先 reject，将在 §3.2+ 按需实现。
 */

import type { AspectRatio, FormatProfile, Project } from '@jingxu/domain';
import { DEFAULT_SUBTITLE_SAFE_AREA, createFormatProfileSpec } from '@jingxu/domain';
import type { ProjectListScope } from '@jingxu/contracts';
import type { FormatProfileRepository } from '../ports/project/format-profile-repository';
import type { Clock, IdGenerator, StableHasher } from '../ports/project/service-dependencies';
import type {
  ProjectKeyset,
  ProjectListItem,
  ProjectListPage,
  ProjectListQuery,
  ProjectRepository,
  ProjectSearchScan,
  ProjectSearchScanQuery,
} from '../ports/project/project-repository';
import type { ProjectDirectoryPort } from '../ports/project/project-directory-port';
import type {
  ProjectRepositories,
  ProjectUnitOfWorkPort,
} from '../ports/project/project-unit-of-work';

import { createStableHasher } from './stable-serialization';

const unused = (method: string): Error => new Error(`${method} not used in §3.1 list/get tests`);

// ─── builders：构造合法默认领域对象，测试按需覆盖字段 ────────────────────────

export const makeProject = (overrides: Partial<Project>): Project => ({
  id: 'proj_seed000001',
  name: '示例项目',
  genre: null,
  style: null,
  creationMode: 'AI_ORIGINAL',
  dialogueRenderMode: 'NARRATION_FIRST',
  deploymentMode: 'LOCAL_DEMO',
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
  deletedAt: null,
  ...overrides,
});

export const makeFormatProfile = (overrides: Partial<FormatProfile>): FormatProfile => ({
  id: 'fp_seed000001',
  projectId: 'proj_seed000001',
  versionNo: 1,
  parentId: null,
  spec: createFormatProfileSpec('9:16', DEFAULT_SUBTITLE_SAFE_AREA),
  isCurrent: true,
  createdAt: '2026-08-09T00:00:00.000Z',
  ...overrides,
});

// ─── store：可种子的内存数据集 ──────────────────────────────────────────────

export interface InMemoryStore {
  readonly projects: Project[];
  readonly profiles: FormatProfile[];
}

export const createInMemoryStore = (): InMemoryStore => ({ projects: [], profiles: [] });

/** 种入一个 Project 及其若干 FormatProfile 版本（首个默认 current）。 */
export const seedProject = (
  store: InMemoryStore,
  project: Project,
  profiles: FormatProfile[],
): void => {
  store.projects.push(project);
  store.profiles.push(...profiles);
};

// ─── keyset 工具：内存镜像 SQLite 的稳定排序与定位 ───────────────────────────

const inScope = (project: Project, scope: ProjectListScope): boolean =>
  scope === 'DELETED' ? project.deletedAt !== null : project.deletedAt === null;

/** 按 updated_at DESC, id DESC 稳定排序（Design §7）。 */
const sortByKeysetDesc = (items: readonly Project[]): Project[] =>
  [...items].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    if (a.id !== b.id) return a.id < b.id ? 1 : -1;
    return 0;
  });

/** p 是否严格排在 cursor 之后（DESC 中更小），即下一页候选。 */
const isAfterCursor = (project: Project, cursor: ProjectKeyset): boolean =>
  project.updatedAt < cursor.updatedAt ||
  (project.updatedAt === cursor.updatedAt && project.id < cursor.id);

const startIndexAfter = (sorted: readonly Project[], after: ProjectKeyset | null): number => {
  if (after === null) return 0;
  const found = sorted.findIndex((p) => isAfterCursor(p, after));
  return found === -1 ? sorted.length : found;
};

// ─── ProjectRepository（list/get 路径实现，写命令 reject）────────────────────

export const createInMemoryProjectRepository = (store: InMemoryStore): ProjectRepository => {
  const currentAspectRatioOf = (projectId: string): AspectRatio => {
    const current = store.profiles.find((fp) => fp.projectId === projectId && fp.isCurrent);
    if (!current) throw new Error(`seed invariant: no current FormatProfile for ${projectId}`);
    return current.spec.aspectRatio;
  };

  const toItem = (project: Project): ProjectListItem => ({
    project,
    currentAspectRatio: currentAspectRatioOf(project.id),
  });

  return {
    findById: (id, scope) => {
      const project = store.projects.find((p) => p.id === id);
      return Promise.resolve(project && inScope(project, scope) ? project : null);
    },
    findActiveNameRefs: () => Promise.reject(unused('findActiveNameRefs')),
    listPage: (query: ProjectListQuery): Promise<ProjectListPage> => {
      const sorted = sortByKeysetDesc(store.projects.filter((p) => inScope(p, query.scope)));
      const start = startIndexAfter(sorted, query.after);
      const page = sorted.slice(start, start + query.limit);
      const hasNext = start + query.limit < sorted.length;
      const last = page[page.length - 1];
      const nextAfter =
        hasNext && last !== undefined ? { updatedAt: last.updatedAt, id: last.id } : null;
      return Promise.resolve({ items: page.map(toItem), nextAfter, truncated: false });
    },
    scanForSearch: (query: ProjectSearchScanQuery): Promise<ProjectSearchScan> => {
      const sorted = sortByKeysetDesc(store.projects.filter((p) => inScope(p, query.scope)));
      const start = startIndexAfter(sorted, query.after);
      const remaining = sorted.length - start;
      const truncated = remaining > query.hardLimit;
      const candidates = sorted.slice(start, start + query.hardLimit).map(toItem);
      return Promise.resolve({ candidates, truncated });
    },
    insert: () => Promise.reject(unused('insert')),
    update: () => Promise.reject(unused('update')),
  };
};

// ─── FormatProfileRepository（findAllByProject 实现，其余 reject）─────────────

export const createInMemoryFormatProfileRepository = (
  store: InMemoryStore,
): FormatProfileRepository => ({
  findCurrent: () => Promise.reject(unused('findCurrent')),
  findAllByProject: (projectId) =>
    Promise.resolve(
      store.profiles
        .filter((fp) => fp.projectId === projectId)
        .sort((a, b) => a.versionNo - b.versionNo),
    ),
  findMaxVersionNo: () => Promise.reject(unused('findMaxVersionNo')),
  isCurrentReferencedByShotContract: () =>
    Promise.reject(unused('isCurrentReferencedByShotContract')),
  insert: () => Promise.reject(unused('insert')),
  unsetCurrent: () => Promise.reject(unused('unsetCurrent')),
});

// ─── 聚合 Repositories + UnitOfWork（共享同一 store，无真实事务）─────────────

export const createInMemoryRepositories = (store: InMemoryStore): ProjectRepositories => ({
  projects: createInMemoryProjectRepository(store),
  formatProfiles: createInMemoryFormatProfileRepository(store),
  receipts: {
    findByRequestId: () => Promise.reject(unused('receipts.findByRequestId')),
    insert: () => Promise.reject(unused('receipts.insert')),
  },
  audit: {
    record: () => Promise.reject(unused('audit.record')),
  },
  analytics: {
    record: () => Promise.reject(unused('analytics.record')),
  },
});

export const createInMemoryUnitOfWork = (
  repositories: ProjectRepositories,
): ProjectUnitOfWorkPort => ({
  run: (work) => work(repositories),
});

// ─── 注入依赖 Fake（clock/id/dir 在 §3.1 list/get 不调用）───────────────────

export const createFakeClock = (fixedNow: number): Clock => ({ now: () => fixedNow });

export const createFakeIdGenerator = (ids: readonly string[] = []): IdGenerator => {
  let i = 0;
  return {
    newId: () => {
      const id = ids[i];
      if (id === undefined) throw new Error('FakeIdGenerator exhausted');
      i += 1;
      return id;
    },
  };
};

export const createFakeStableHasher = (): StableHasher =>
  createStableHasher((input) => `sha:${input}`);

export const createFakeDirectoryPort = (): ProjectDirectoryPort => ({
  prepare: () => Promise.reject(unused('directory.prepare')),
  cleanupIfCreatedEmpty: () => Promise.reject(unused('directory.cleanupIfCreatedEmpty')),
});
