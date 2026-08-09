import { describe, expect, it } from 'vitest';

import type {
  AppResultDto,
  CreateProjectInputDto,
  ProjectDetailDto,
  ProjectListResultDto,
  UpdateProjectInputDto,
} from '@jingxu/contracts';
import { DEFAULT_SUBTITLE_SAFE_AREA, DIALOGUE_RENDER_MODES } from '@jingxu/domain';

import { createProjectService } from './project-service';
import {
  createFakeClock,
  createFakeDirectoryPort,
  createFakeIdGenerator,
  createFakeStableHasher,
  createInMemoryRepositories,
  createInMemoryStore,
  createInMemoryUnitOfWork,
  makeFormatProfile,
  makeProject,
  seedProject,
} from './in-memory-ports';
import type { FakeDirectoryPort, ProjectWriteFault, ProjectWriteFaults } from './in-memory-ports';

/** 合法系统 ID（满足 cursor ID_RE 12–64）。 */
const pid = (n: number): string => `proj${String(n).padStart(12, '0')}`;
const fid = (n: number): string => `fp${String(n).padStart(13, '0')}`;
const TRACE = 'trace-aaaaaaaa';
const T10 = '2026-08-09T10:00:00.000Z';
const T11 = '2026-08-09T11:00:00.000Z';

interface SetupOptions {
  readonly ids?: readonly string[];
  readonly prepareError?: Error;
  readonly faults?: ProjectWriteFaults;
}

interface Setup {
  readonly service: ReturnType<typeof createProjectService>;
  readonly store: ReturnType<typeof createInMemoryStore>;
  readonly directory: FakeDirectoryPort;
}

const setup = (opts: SetupOptions = {}): Setup => {
  const store = createInMemoryStore();
  const directory = createFakeDirectoryPort(
    opts.prepareError !== undefined ? { prepareError: opts.prepareError } : {},
  );
  const service = createProjectService({
    unitOfWork: createInMemoryUnitOfWork(createInMemoryRepositories(store, opts.faults), store),
    clock: createFakeClock(Date.parse('2026-08-09T12:00:00.000Z')),
    idGenerator: createFakeIdGenerator(opts.ids),
    hasher: createFakeStableHasher(),
    directory,
  });
  return { service, store, directory };
};

const okList = async (
  service: Setup['service'],
  scope: 'ACTIVE' | 'DELETED',
  opts: {
    readonly limit?: number;
    readonly cursor?: string | null;
    readonly search?: string | null;
  } = {},
): Promise<ProjectListResultDto> => {
  const result: AppResultDto<ProjectListResultDto> = await service.list(
    {
      scope,
      limit: opts.limit ?? 10,
      cursor: opts.cursor === undefined ? null : opts.cursor,
      search: opts.search === undefined ? null : opts.search,
    },
    TRACE,
  );
  if (!result.ok) throw new Error(`expected ok list, got ${result.error.code}`);
  return result.data;
};

const idsOf = (page: ProjectListResultDto): readonly string[] => page.items.map((i) => i.id);

describe('ProjectService.list — 稳定 keyset 与 scope 隔离（§3.1）', () => {
  it('真实空：无活动项目返回空、无 cursor、不截断', async () => {
    const { service } = setup();
    const page = await okList(service, 'ACTIVE');
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.truncated).toBe(false);
  });

  it('ACTIVE/DELETED 隔离：默认列表只含活动，回收站只含软删除', async () => {
    const { service, store } = setup();
    const active = makeProject({ id: pid(1), updatedAt: T10 });
    const deleted = makeProject({ id: pid(2), updatedAt: T10, deletedAt: T11 });
    seedProject(store, active, [makeFormatProfile({ id: fid(1), projectId: active.id })]);
    seedProject(store, deleted, [makeFormatProfile({ id: fid(2), projectId: deleted.id })]);

    expect(idsOf(await okList(service, 'ACTIVE'))).toEqual([pid(1)]);
    expect(idsOf(await okList(service, 'DELETED'))).toEqual([pid(2)]);
  });

  it('updatedAt DESC, id DESC：同更新时间按 id 降序 tie-break，不重复不遗漏', async () => {
    const { service, store } = setup();
    const older = makeProject({ id: pid(1), updatedAt: T10 });
    const newer = makeProject({ id: pid(3), updatedAt: T11 });
    const tieA = makeProject({ id: pid(2), updatedAt: T11 });
    for (const p of [older, newer, tieA]) {
      seedProject(store, p, [
        makeFormatProfile({ id: fid(Number(p.id.slice(4))), projectId: p.id }),
      ]);
    }

    // newer(T11) 先于 older(T10)；同为 T11 的 pid(3) > pid(2) → pid(3) 在前
    expect(idsOf(await okList(service, 'ACTIVE'))).toEqual([pid(3), pid(2), pid(1)]);
  });

  it('limit/cursor：分页接续，末页 nextCursor 为 null', async () => {
    const { service, store } = setup();
    for (const n of [1, 2, 3]) {
      const p = makeProject({ id: pid(n), updatedAt: T10 });
      seedProject(store, p, [makeFormatProfile({ id: fid(n), projectId: p.id })]);
    }

    const page1 = await okList(service, 'ACTIVE', { limit: 2 });
    expect(idsOf(page1)).toEqual([pid(3), pid(2)]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await okList(service, 'ACTIVE', { limit: 2, cursor: page1.nextCursor });
    expect(idsOf(page2)).toEqual([pid(1)]);
    expect(page2.nextCursor).toBeNull();
  });

  it('cursor 的 scope 与请求不一致 → IPC_INVALID_REQUEST', async () => {
    const { service, store } = setup();
    const p1 = makeProject({ id: pid(1), updatedAt: T10 });
    const p2 = makeProject({ id: pid(2), updatedAt: T11 });
    seedProject(store, p1, [makeFormatProfile({ id: fid(1), projectId: p1.id })]);
    seedProject(store, p2, [makeFormatProfile({ id: fid(2), projectId: p2.id })]);

    const activePage = await okList(service, 'ACTIVE', { limit: 1 });
    const cursor = activePage.nextCursor;
    if (cursor === null) throw new Error('expected a cursor');

    const result = await service.list({ scope: 'DELETED', limit: 1, cursor, search: null }, TRACE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('IPC_INVALID_REQUEST');
      expect(result.error.traceId).toBe(TRACE);
    }
  });

  it('名称搜索：按规范化名称 contains 过滤，无匹配返回空且不截断', async () => {
    const { service, store } = setup();
    const alpha = makeProject({ id: pid(1), name: 'Project Alpha', updatedAt: T10 });
    const upper = makeProject({ id: pid(2), name: 'ALPHA 漫画', updatedAt: T11 });
    const other = makeProject({ id: pid(3), name: '不相关项目', updatedAt: T10 });
    for (const p of [alpha, upper, other]) {
      seedProject(store, p, [
        makeFormatProfile({ id: fid(Number(p.id.slice(4))), projectId: p.id }),
      ]);
    }

    // search 'alpha' 经 zh-CN 小写归一后匹配前两个（大小写等价），保持稳定排序
    const matched = await okList(service, 'ACTIVE', { search: 'alpha' });
    expect(idsOf(matched)).toEqual([pid(2), pid(1)]);

    const empty = await okList(service, 'ACTIVE', { search: '不存在的文本' });
    expect(empty.items).toEqual([]);
    expect(empty.truncated).toBe(false);
  });
});

describe('ProjectService.get — 详情 current/history 与 PROJECT_NOT_FOUND（§3.1）', () => {
  it('返回 current FormatProfile 与不含当前的历史版本', async () => {
    const { service, store } = setup();
    const p = makeProject({ id: pid(1), updatedAt: T11 });
    const v1 = makeFormatProfile({ id: fid(1), projectId: p.id, versionNo: 1, isCurrent: false });
    const v2 = makeFormatProfile({
      id: fid(2),
      projectId: p.id,
      versionNo: 2,
      parentId: fid(1),
      isCurrent: true,
    });
    seedProject(store, p, [v1, v2]);

    const result = await service.get({ projectId: pid(1), scope: 'ACTIVE' }, TRACE);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok get');
    const detail: ProjectDetailDto = result.data;
    expect(detail.id).toBe(pid(1));
    expect(detail.currentFormatProfile.id).toBe(fid(2));
    expect(detail.currentFormatProfile.versionNo).toBe(2);
    expect(detail.formatProfileHistory.map((f) => f.versionNo)).toEqual([1]);
  });

  it('不存在 → PROJECT_NOT_FOUND', async () => {
    const { service } = setup();
    const result = await service.get({ projectId: pid(99), scope: 'ACTIVE' }, TRACE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('scope 隔离：已删除项目在 ACTIVE 返回 NOT_FOUND，DELETED 可取', async () => {
    const { service, store } = setup();
    const deleted = makeProject({ id: pid(1), updatedAt: T10, deletedAt: T11 });
    seedProject(store, deleted, [makeFormatProfile({ id: fid(1), projectId: deleted.id })]);

    const activeRes = await service.get({ projectId: pid(1), scope: 'ACTIVE' }, TRACE);
    expect(activeRes.ok).toBe(false);
    if (!activeRes.ok) expect(activeRes.error.code).toBe('PROJECT_NOT_FOUND');

    const deletedRes = await service.get({ projectId: pid(1), scope: 'DELETED' }, TRACE);
    expect(deletedRes.ok).toBe(true);
  });
});

// ─── create 辅助 ──────────────────────────────────────────────────────────

const baseCreateInput = (
  overrides: Partial<CreateProjectInputDto> = {},
): CreateProjectInputDto => ({
  requestId: 'req-aaaaaaaa',
  name: '示例项目',
  genre: null,
  style: null,
  creationMode: 'AI_ORIGINAL',
  dialogueRenderMode: 'NARRATION_FIRST',
  aspectRatio: '9:16',
  subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
  ...overrides,
});

const okCreate = async (
  service: Setup['service'],
  input: CreateProjectInputDto,
): Promise<ProjectDetailDto> => {
  const result: AppResultDto<ProjectDetailDto> = await service.create(input, TRACE);
  if (!result.ok) throw new Error(`expected ok create, got ${result.error.code}`);
  return result.data;
};

const CREATE_WRITE_FAULTS: readonly (readonly [string, ProjectWriteFault])[] = [
  ['insert project', 'insertProject'],
  ['insert format profile', 'insertFormatProfile'],
  ['record audit', 'recordAudit'],
  ['record analytics', 'recordAnalytics'],
  ['insert receipt', 'insertReceipt'],
];

/** 构造单点故障注入（避免计算属性键字面量的类型摩擦）。 */
const singleFault = (fault: ProjectWriteFault): ProjectWriteFaults => {
  const faults: ProjectWriteFaults = {};
  faults[fault] = new Error('inject');
  return faults;
};

describe('ProjectService.create — 原子保存 Project 与首个 FormatProfile（§3.2）', () => {
  it('默认值创建:9:16/NARRATION_FIRST/LOCAL_DEMO，完整证据原子提交', async () => {
    const { service, store } = setup();

    const detail = await okCreate(service, baseCreateInput());

    expect(detail.deploymentMode).toBe('LOCAL_DEMO');
    expect(detail.creationMode).toBe('AI_ORIGINAL');
    expect(detail.dialogueRenderMode).toBe('NARRATION_FIRST');
    expect(detail.currentFormatProfile.aspectRatio).toBe('9:16');
    expect(detail.currentFormatProfile.width).toBe(1080);
    expect(detail.currentFormatProfile.height).toBe(1920);
    expect(detail.currentFormatProfile.fps).toBe(30);
    expect(detail.currentFormatProfile.language).toBe('zh-CN');
    expect(detail.currentFormatProfile.versionNo).toBe(1);
    expect(detail.currentFormatProfile.parentId).toBeNull();
    expect(detail.currentFormatProfile.isCurrent).toBe(true);
    expect(detail.currentFormatProfile.subtitleSafeArea).toEqual({
      top: 5,
      right: 5,
      bottom: 12,
      left: 5,
    });
    expect(detail.formatProfileHistory).toEqual([]);

    // 单事务原子证据：1 Project + 1 FormatProfile(v1/current) + 1 audit + 2 analytics + 1 receipt
    expect(store.projects).toHaveLength(1);
    expect(store.profiles).toHaveLength(1);
    expect(store.audit).toHaveLength(1);
    expect(store.audit[0]?.action).toBe('PROJECT_CREATED');
    expect(store.analytics.map((e) => e.eventName).sort()).toEqual([
      'dialogue_mode_selected',
      'project_created',
    ]);
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]?.commandName).toBe('CREATE_PROJECT');
    expect(store.receipts[0]?.resultRef.changed).toBe(true);
  });

  it.each(DIALOGUE_RENDER_MODES)('横屏 16:9 + 对白模式 %s', async (mode) => {
    const { service, store } = setup();
    const detail = await okCreate(
      service,
      baseCreateInput({
        aspectRatio: '16:9',
        dialogueRenderMode: mode,
      }),
    );

    expect(detail.currentFormatProfile.aspectRatio).toBe('16:9');
    expect(detail.currentFormatProfile.width).toBe(1920);
    expect(detail.currentFormatProfile.height).toBe(1080);
    expect(detail.dialogueRenderMode).toBe(mode);
    expect(store.projects[0]?.dialogueRenderMode).toBe(mode);
  });

  it('字段错误:首尾空白名称 → IPC_INVALID_REQUEST + fieldErrors.name + 零记录', async () => {
    const { service, store } = setup();

    const result = await service.create(baseCreateInput({ name: ' 带空白 ' }), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('IPC_INVALID_REQUEST');
      expect(result.error.fieldErrors?.name).toBeTruthy();
      expect(result.error.traceId).toBe(TRACE);
    }
    expect(store.projects).toHaveLength(0);
    expect(store.profiles).toHaveLength(0);
  });

  it('名称冲突:zh-CN 大小写归一后与活动项目重名 → PROJECT_NAME_CONFLICT，无新增', async () => {
    const { service, store } = setup();
    seedProject(store, makeProject({ id: pid(1), name: 'Alpha' }), [
      makeFormatProfile({ id: fid(1), projectId: pid(1) }),
    ]);

    const result = await service.create(baseCreateInput({ name: 'ALPHA' }), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_NAME_CONFLICT');
    expect(store.projects).toHaveLength(1); // 仍是种子那 1 个
    expect(store.profiles).toHaveLength(1);
  });

  it('目录不可用:prepare 失败 → PROJECT_DIRECTORY_UNAVAILABLE，零记录零事件', async () => {
    const { service, store, directory } = setup({ prepareError: new Error('fs down') });

    const result = await service.create(baseCreateInput(), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_DIRECTORY_UNAVAILABLE');
    expect(store.projects).toHaveLength(0);
    expect(store.profiles).toHaveLength(0);
    expect(store.audit).toHaveLength(0);
    expect(store.analytics).toHaveLength(0);
    expect(directory.prepareCalls).toBe(1);
  });

  it.each(CREATE_WRITE_FAULTS)(
    '事务中途失败:%s → PROJECT_PERSISTENCE_FAILED，原子回滚零部分结果 + 补偿清理',
    async (_label, fault) => {
      const { service, store, directory } = setup({ faults: singleFault(fault) });

      const result = await service.create(baseCreateInput(), TRACE);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('PROJECT_PERSISTENCE_FAILED');
      expect(store.projects).toHaveLength(0);
      expect(store.profiles).toHaveLength(0);
      expect(store.audit).toHaveLength(0);
      expect(store.analytics).toHaveLength(0);
      expect(store.receipts).toHaveLength(0);
      expect(directory.cleanupCalls).toBe(1);
    },
  );

  it('系统字段派生:id/时间/deploymentMode 由系统派生，请求不携带', async () => {
    const { service } = setup({ ids: ['proj-derived001', 'fp-derived000001'] });

    const detail = await okCreate(service, baseCreateInput());

    expect(detail.id).toBe('proj-derived001');
    expect(detail.currentFormatProfile.id).toBe('fp-derived000001');
    expect(detail.createdAt).toBe(detail.updatedAt);
    expect(detail.deploymentMode).toBe('LOCAL_DEMO');
  });
});

// ─── update 辅助 ──────────────────────────────────────────────────────────

/** 种入单个活动 project（pid(1)，updatedAt T10）+ v1 current profile（9:16/默认安全区）。 */
const seedSingleProject = (store: Setup['store']): void => {
  seedProject(store, makeProject({ id: pid(1), updatedAt: T10 }), [
    makeFormatProfile({ id: fid(1), projectId: pid(1), versionNo: 1 }),
  ]);
};

/**
 * 默认携带与 {@link seedSingleProject} 种子完全一致的字段 → no-op 基线；
 * expectedUpdatedAt 默认 T10（与种子 updatedAt 一致），按测试覆盖。
 */
const baseUpdateInput = (
  overrides: Partial<UpdateProjectInputDto> = {},
): UpdateProjectInputDto => ({
  requestId: 'req-aaaaaaaa',
  projectId: pid(1),
  expectedUpdatedAt: T10,
  name: '示例项目',
  genre: null,
  style: null,
  dialogueRenderMode: 'NARRATION_FIRST',
  aspectRatio: '9:16',
  subtitleSafeArea: { ...DEFAULT_SUBTITLE_SAFE_AREA },
  ...overrides,
});

const okUpdate = async (
  service: Setup['service'],
  input: UpdateProjectInputDto,
): Promise<ProjectDetailDto> => {
  const result: AppResultDto<ProjectDetailDto> = await service.update(input, TRACE);
  if (!result.ok) throw new Error(`expected ok update, got ${result.error.code}`);
  return result.data;
};

const UPDATE_WRITE_FAULTS: readonly (readonly [string, ProjectWriteFault])[] = [
  ['update project', 'updateProject'],
  ['unset current profile', 'unsetCurrent'],
  ['insert format profile', 'insertFormatProfile'],
  ['record audit', 'recordAudit'],
  ['record analytics', 'recordAnalytics'],
  ['insert receipt', 'insertReceipt'],
];

describe('ProjectService.update — 乐观并发与 FormatProfile 版本链（§3.3）', () => {
  it('场景 1 只更元数据：name 变 → updatedAt 前进 + 1 audit + 0 新 profile + 0 event + 1 receipt(changed:true)', async () => {
    const { service, store } = setup();
    seedSingleProject(store);

    const detail = await okUpdate(service, baseUpdateInput({ name: '新名称' }));

    expect(detail.name).toBe('新名称');
    expect(detail.updatedAt).toBe('2026-08-09T12:00:00.000Z');
    expect(store.profiles).toHaveLength(1);
    expect(store.analytics).toHaveLength(0);
    expect(store.audit.map((a) => a.action)).toEqual(['PROJECT_UPDATED']);
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]?.commandName).toBe('UPDATE_PROJECT');
    expect(store.receipts[0]?.resultRef.changed).toBe(true);
    expect(store.projects[0]?.name).toBe('新名称');
    expect(store.projects[0]?.updatedAt).toBe('2026-08-09T12:00:00.000Z');
  });

  it('dialogueRenderMode 变化才写 dialogue_mode_selected（对比场景 1 不写）', async () => {
    const { service, store } = setup();
    seedSingleProject(store);

    const detail = await okUpdate(
      service,
      baseUpdateInput({ dialogueRenderMode: 'WEAK_LIP_SYNC' }),
    );

    expect(detail.dialogueRenderMode).toBe('WEAK_LIP_SYNC');
    expect(store.analytics.map((e) => e.eventName)).toEqual(['dialogue_mode_selected']);
    expect(store.analytics[0]?.properties).toMatchObject({
      dialogueRenderMode: 'WEAK_LIP_SYNC',
      source: 'PROJECT_SETTINGS',
    });
  });

  it('场景 2 画幅变更生成新版本：9:16→16:9 插入 v2(parentId=v1、isCurrent=true)，v1 落 history 不被覆盖', async () => {
    const { service, store } = setup({ ids: ['fp-v2-derived1'] });
    seedSingleProject(store);

    const detail = await okUpdate(service, baseUpdateInput({ aspectRatio: '16:9' }));

    expect(detail.currentFormatProfile.id).toBe('fp-v2-derived1');
    expect(detail.currentFormatProfile.versionNo).toBe(2);
    expect(detail.currentFormatProfile.parentId).toBe(fid(1));
    expect(detail.currentFormatProfile.aspectRatio).toBe('16:9');
    expect(detail.currentFormatProfile.isCurrent).toBe(true);
    expect(detail.formatProfileHistory.map((f) => f.versionNo)).toEqual([1]);
    // store 中 v1 现 isCurrent=false、v2 current；旧 spec 未被覆盖（版本链可追溯）
    const v1 = store.profiles.find((fp) => fp.id === fid(1));
    expect(v1?.isCurrent).toBe(false);
    expect(v1?.spec.aspectRatio).toBe('9:16');
    expect(store.audit.map((a) => a.action)).toEqual([
      'FORMAT_PROFILE_VERSIONED',
      'PROJECT_UPDATED',
    ]);
    expect(store.receipts[0]?.resultRef.changed).toBe(true);
  });

  it('场景 3 无变化不造版本：no-op → 0 新 profile + 0 audit + 0 event + 1 receipt(changed:false)，updatedAt 不变', async () => {
    const { service, store } = setup();
    seedSingleProject(store);

    const detail = await okUpdate(service, baseUpdateInput());

    expect(detail.updatedAt).toBe(T10);
    expect(store.profiles).toHaveLength(1);
    expect(store.audit).toHaveLength(0);
    expect(store.analytics).toHaveLength(0);
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]?.resultRef.changed).toBe(false);
    expect(store.projects[0]?.updatedAt).toBe(T10);
  });

  it('单调 revision：clock 固定同毫秒，连续两次 update → updatedAt 严格递增', async () => {
    const { service, store } = setup();
    seedSingleProject(store);

    const first = await okUpdate(service, baseUpdateInput({ name: '第一次' }));
    const second = await okUpdate(
      service,
      baseUpdateInput({ name: '第二次', expectedUpdatedAt: first.updatedAt }),
    );

    expect(first.updatedAt).toBe('2026-08-09T12:00:00.000Z');
    expect(second.updatedAt).toBe('2026-08-09T12:00:00.001Z');
    // 第二次乐观锁基于第一次结果生效
    expect(store.projects[0]?.name).toBe('第二次');
  });

  it('场景 4 陈旧 expectedUpdatedAt → PROJECT_VERSION_CONFLICT(retryable)，零新增', async () => {
    const { service, store } = setup();
    seedSingleProject(store);

    const result = await service.update(
      baseUpdateInput({ name: '冲突', expectedUpdatedAt: '2026-08-08T00:00:00.000Z' }),
      TRACE,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PROJECT_VERSION_CONFLICT');
      expect(result.error.retryable).toBe(true);
      expect(result.error.traceId).toBe(TRACE);
    }
    // 种子未变、零新增（无 profile/audit/event/receipt）
    expect(store.projects[0]?.name).toBe('示例项目');
    expect(store.profiles).toHaveLength(1);
    expect(store.audit).toHaveLength(0);
    expect(store.analytics).toHaveLength(0);
    expect(store.receipts).toHaveLength(0);
  });

  it('场景 5 下游依赖阻断：ShotContract 引用 current + 改画幅 → FORMAT_PROFILE_DEPENDENCY_BLOCKED，种子不变', async () => {
    const { service, store } = setup();
    seedSingleProject(store);
    store.shotContractReferencedProfileIds.add(fid(1));

    const result = await service.update(baseUpdateInput({ aspectRatio: '16:9' }), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORMAT_PROFILE_DEPENDENCY_BLOCKED');
    // 检查在写入前纯读阶段短路 → 种子 Project/Profile 均不变
    expect(store.projects[0]?.updatedAt).toBe(T10);
    expect(store.profiles).toHaveLength(1);
    expect(store.profiles[0]?.id).toBe(fid(1));
    expect(store.profiles[0]?.isCurrent).toBe(true);
    expect(store.audit).toHaveLength(0);
  });

  it('不存在 → PROJECT_NOT_FOUND', async () => {
    const { service } = setup();

    const result = await service.update(baseUpdateInput({ projectId: pid(99) }), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('字段错误：首尾空白名称 → IPC_INVALID_REQUEST + fieldErrors.name + 零写入', async () => {
    const { service, store } = setup();
    seedSingleProject(store);

    const result = await service.update(baseUpdateInput({ name: ' 带空白 ' }), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('IPC_INVALID_REQUEST');
      expect(result.error.fieldErrors?.name).toBeTruthy();
    }
    expect(store.projects[0]?.name).toBe('示例项目');
    expect(store.audit).toHaveLength(0);
    expect(store.receipts).toHaveLength(0);
  });

  it('名称冲突：种入另一同名活动项目，改 name 撞它 → PROJECT_NAME_CONFLICT（自身排除）', async () => {
    const { service, store } = setup();
    seedSingleProject(store);
    seedProject(store, makeProject({ id: pid(2), name: '已占用名称', updatedAt: T11 }), [
      makeFormatProfile({ id: fid(2), projectId: pid(2), versionNo: 1 }),
    ]);

    const result = await service.update(baseUpdateInput({ name: '已占用名称' }), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_NAME_CONFLICT');
    expect(store.projects[0]?.name).toBe('示例项目');
    expect(store.audit).toHaveLength(0);
  });

  it.each(UPDATE_WRITE_FAULTS)(
    '更新失败不产生成功事件：%s 故障 → PROJECT_PERSISTENCE_FAILED，回滚到种子',
    async (_label, fault) => {
      const { service, store } = setup({ faults: singleFault(fault) });
      seedSingleProject(store);

      // 三处同时变（metadata + profile + dialogueMode）使全部写入步骤进入路径
      const result = await service.update(
        baseUpdateInput({
          name: '改名',
          aspectRatio: '16:9',
          dialogueRenderMode: 'SUBTITLE_ONLY',
        }),
        TRACE,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('PROJECT_PERSISTENCE_FAILED');
      // 回滚到种子状态：project 元数据/updatedAt 未变、仅 v1 current、零审计/事件/回执
      expect(store.projects).toHaveLength(1);
      expect(store.projects[0]?.name).toBe('示例项目');
      expect(store.projects[0]?.updatedAt).toBe(T10);
      expect(store.profiles).toHaveLength(1);
      expect(store.profiles[0]?.id).toBe(fid(1));
      expect(store.profiles[0]?.isCurrent).toBe(true);
      expect(store.audit).toHaveLength(0);
      expect(store.analytics).toHaveLength(0);
      expect(store.receipts).toHaveLength(0);
    },
  );

  it('元数据 + FormatProfile 同时变：name + aspectRatio → 2 audit + v2 + receipt(changed:true)，无 event', async () => {
    const { service, store } = setup({ ids: ['fp-both-derived'] });
    seedSingleProject(store);

    const detail = await okUpdate(service, baseUpdateInput({ name: '改名', aspectRatio: '16:9' }));

    expect(detail.name).toBe('改名');
    expect(detail.currentFormatProfile.aspectRatio).toBe('16:9');
    expect(detail.currentFormatProfile.versionNo).toBe(2);
    expect(store.audit.map((a) => a.action)).toEqual([
      'FORMAT_PROFILE_VERSIONED',
      'PROJECT_UPDATED',
    ]);
    expect(store.analytics).toHaveLength(0); // dialogueMode 未变
    expect(store.receipts[0]?.resultRef.changed).toBe(true);
  });
});
