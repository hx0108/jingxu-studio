/**
 * 内存 Fake Ports 与依赖（test-only infra）。
 *
 * 为 ProjectService Unit 测试提供确定性、可种子的内存实现。keyset 排序与 scope 过滤
 * 是真实算法的简化镜像（`updated_at DESC, id DESC`），使分页行为可独立于 SQLite 验证。
 * §3.1 list/get 路径覆盖；§3.2 create 写路径覆盖；§3.3 update 路径覆盖（乐观锁 +
 * findCurrent/unsetCurrent/版本链 + ShotContract 引用占位）；§3.4 delete/restore 路径
 * 复用 findById(scope)/findActiveNameRefs/update（全量覆盖，含软删除/恢复）。
 * 快照回滚 unitOfWork + 故障注入贯穿所有写路径。
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
import type { CommandReceipt } from '../ports/project/command-receipt-repository';
import type { AuditEntry } from '../ports/project/audit-repository';
import type { AnalyticsEvent } from '../ports/project/analytics-repository';

import { createStableHasher } from './stable-serialization';

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
  readonly receipts: CommandReceipt[];
  readonly audit: AuditEntry[];
  readonly analytics: AnalyticsEvent[];
  /** V1 无真实 ShotContract 数据；用被引用的 current FormatProfile id 集合表达下游依赖（§3.3 占位，真实 Fixture 在 §5.6）。 */
  readonly shotContractReferencedProfileIds: Set<string>;
}

export const createInMemoryStore = (): InMemoryStore => ({
  projects: [],
  profiles: [],
  receipts: [],
  audit: [],
  analytics: [],
  shotContractReferencedProfileIds: new Set(),
});

/** 种入一个 Project 及其若干 FormatProfile 版本（首个默认 current）。 */
export const seedProject = (
  store: InMemoryStore,
  project: Project,
  profiles: FormatProfile[],
): void => {
  store.projects.push(project);
  store.profiles.push(...profiles);
};

// ─── 写命令故障注入：支撑 §3.2 Scenario 5「任一写入故障点」遍历 ──────────────

/** create/update 等写命令的写入步骤故障点。 */
export type ProjectWriteFault =
  | 'insertProject'
  | 'insertFormatProfile'
  | 'recordAudit'
  | 'recordAnalytics'
  | 'insertReceipt'
  | 'updateProject'
  | 'unsetCurrent';

/** 每个故障点可注入一个 Error；设置后该步 reject，使整事务回滚。 */
export type ProjectWriteFaults = Partial<Record<ProjectWriteFault, Error>>;

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

// ─── ProjectRepository（list/get + create 路径实现，update 仍 reject）─────────

export const createInMemoryProjectRepository = (
  store: InMemoryStore,
  faults: ProjectWriteFaults = {},
): ProjectRepository => {
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
    findActiveNameRefs: (excludeProjectId) =>
      Promise.resolve(
        store.projects
          .filter((p) => p.deletedAt === null && p.id !== excludeProjectId)
          .map((p) => ({ projectId: p.id, name: p.name })),
      ),
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
    insert: (project) => {
      if (faults.insertProject !== undefined) return Promise.reject(faults.insertProject);
      store.projects.push(project);
      return Promise.resolve();
    },
    update: (project, expectedUpdatedAt) => {
      if (faults.updateProject !== undefined) return Promise.reject(faults.updateProject);
      const idx = store.projects.findIndex((p) => p.id === project.id);
      const existing = idx === -1 ? undefined : store.projects[idx];
      if (existing === undefined) return Promise.resolve(false);
      if (existing.updatedAt !== expectedUpdatedAt) return Promise.resolve(false);
      store.projects[idx] = project;
      return Promise.resolve(true);
    },
  };
};

// ─── FormatProfileRepository（findAllByProject + insert 实现，版本链留 §3.3）───

export const createInMemoryFormatProfileRepository = (
  store: InMemoryStore,
  faults: ProjectWriteFaults = {},
): FormatProfileRepository => ({
  findCurrent: (projectId) =>
    Promise.resolve(
      store.profiles.find((fp) => fp.projectId === projectId && fp.isCurrent) ?? null,
    ),
  findAllByProject: (projectId) =>
    Promise.resolve(
      store.profiles
        .filter((fp) => fp.projectId === projectId)
        .sort((a, b) => a.versionNo - b.versionNo),
    ),
  findMaxVersionNo: (projectId) =>
    Promise.resolve(
      store.profiles
        .filter((fp) => fp.projectId === projectId)
        .reduce((max, fp) => Math.max(max, fp.versionNo), 0),
    ),
  isCurrentReferencedByShotContract: (_projectId, formatProfileId) =>
    Promise.resolve(store.shotContractReferencedProfileIds.has(formatProfileId)),
  insert: (profile) => {
    if (faults.insertFormatProfile !== undefined) return Promise.reject(faults.insertFormatProfile);
    store.profiles.push(profile);
    return Promise.resolve();
  },
  unsetCurrent: (projectId, formatProfileId) => {
    if (faults.unsetCurrent !== undefined) return Promise.reject(faults.unsetCurrent);
    const idx = store.profiles.findIndex(
      (fp) => fp.projectId === projectId && fp.id === formatProfileId,
    );
    const existing = idx === -1 ? undefined : store.profiles[idx];
    if (existing !== undefined) {
      store.profiles[idx] = { ...existing, isCurrent: false };
    }
    return Promise.resolve();
  },
});

// ─── 聚合 Repositories + UnitOfWork（共享同一 store + 快照回滚）──────────────

export const createInMemoryRepositories = (
  store: InMemoryStore,
  faults: ProjectWriteFaults = {},
): ProjectRepositories => ({
  projects: createInMemoryProjectRepository(store, faults),
  formatProfiles: createInMemoryFormatProfileRepository(store, faults),
  receipts: {
    findByRequestId: (requestId) =>
      Promise.resolve(store.receipts.find((r) => r.requestId === requestId) ?? null),
    insert: (receipt) => {
      if (faults.insertReceipt !== undefined) return Promise.reject(faults.insertReceipt);
      store.receipts.push(receipt);
      return Promise.resolve();
    },
  },
  audit: {
    record: (entry) => {
      if (faults.recordAudit !== undefined) return Promise.reject(faults.recordAudit);
      store.audit.push(entry);
      return Promise.resolve();
    },
  },
  analytics: {
    record: (event) => {
      if (faults.recordAnalytics !== undefined) return Promise.reject(faults.recordAnalytics);
      store.analytics.push(event);
      return Promise.resolve();
    },
  },
});

/** store 的浅快照（领域对象不可变，浅拷贝数组即可）。 */
const snapshotOf = (store: InMemoryStore) => ({
  projects: [...store.projects],
  profiles: [...store.profiles],
  receipts: [...store.receipts],
  audit: [...store.audit],
  analytics: [...store.analytics],
});

/** 从快照恢复：清空各数组并回填，保持数组引用不变（镜像 BEGIN IMMEDIATE 回滚）。 */
const restoreFrom = (store: InMemoryStore, snap: ReturnType<typeof snapshotOf>): void => {
  store.projects.length = 0;
  store.projects.push(...snap.projects);
  store.profiles.length = 0;
  store.profiles.push(...snap.profiles);
  store.receipts.length = 0;
  store.receipts.push(...snap.receipts);
  store.audit.length = 0;
  store.audit.push(...snap.audit);
  store.analytics.length = 0;
  store.analytics.push(...snap.analytics);
};

/**
 * 内存 UnitOfWork：work 正常返回即保留写入，抛出即按快照回滚再 rethrow，
 * 使 §3.2「零部分结果」断言可独立于真实 SQLite 事务验证。
 */
export const createInMemoryUnitOfWork = (
  repositories: ProjectRepositories,
  store: InMemoryStore,
): ProjectUnitOfWorkPort => ({
  run: async (work) => {
    const snap = snapshotOf(store);
    try {
      return await work(repositories);
    } catch (e) {
      restoreFrom(store, snap);
      throw e;
    }
  },
});

// ─── 注入依赖 Fake ──────────────────────────────────────────────────────────

export const createFakeClock = (fixedNow: number): Clock => ({ now: () => fixedNow });

/**
 * 确定性 ID 生成器：先用传入序列，耗尽后回退 `gen-<n>`（满足 ID 安全字符集），
 * 使未显式提供 ID 的测试也能完成 create（需 projectId + formatProfileId）。
 */
export const createFakeIdGenerator = (ids: readonly string[] = []): IdGenerator => {
  let i = 0;
  return {
    newId: () => {
      const provided = ids[i];
      const id = provided ?? `gen-${String(i).padStart(12, '0')}`;
      i += 1;
      return id;
    },
  };
};

export const createFakeStableHasher = (): StableHasher =>
  createStableHasher((input) => `sha:${input}`);

/** Fake 目录 Port：默认 prepare 成功；可注入 prepareError 触发 §3.2 Scenario 4。 */
export interface FakeDirectoryPort extends ProjectDirectoryPort {
  readonly prepareCalls: number;
  readonly cleanupCalls: number;
}

export const createFakeDirectoryPort = (
  opts: { readonly prepareError?: Error } = {},
): FakeDirectoryPort => {
  let prepareCalls = 0;
  let cleanupCalls = 0;
  return {
    prepare: (projectId) => {
      prepareCalls += 1;
      return opts.prepareError !== undefined
        ? Promise.reject(opts.prepareError)
        : Promise.resolve({ projectId, created: true });
    },
    cleanupIfCreatedEmpty: () => {
      cleanupCalls += 1;
      return Promise.resolve({ deleted: true } as const);
    },
    get prepareCalls() {
      return prepareCalls;
    },
    get cleanupCalls() {
      return cleanupCalls;
    },
  };
};
