import { describe, expect, it } from 'vitest';

import type {
  AppResultDto,
  CreateProjectInputDto,
  DeleteProjectInputDto,
  ProjectDetailDto,
  ProjectListResultDto,
  RestoreProjectInputDto,
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
      // 两次是不同命令 → 不同 requestId（§3.5 幂等契约：同 requestId+不同载荷会 REQUEST_ID_REUSED）
      baseUpdateInput({
        requestId: 'req-bbbbbbbb',
        name: '第二次',
        expectedUpdatedAt: first.updatedAt,
      }),
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

// ─── delete/restore 辅助 ──────────────────────────────────────────────────

/** 种入单个软删除 project（pid(1)，deletedAt T11 / updatedAt T10）+ v1 current profile。 */
const seedDeletedProject = (store: Setup['store']): void => {
  seedProject(store, makeProject({ id: pid(1), updatedAt: T10, deletedAt: T11 }), [
    makeFormatProfile({ id: fid(1), projectId: pid(1), versionNo: 1 }),
  ]);
};

/**
 * delete/restore 共用 mutation 输入：expectedUpdatedAt 默认 T10，
 * 同时匹配 {@link seedSingleProject}（活动 updatedAt T10）与 {@link seedDeletedProject}（updatedAt T10）。
 */
const baseMutationInput = (
  overrides: Partial<DeleteProjectInputDto> = {},
): DeleteProjectInputDto => ({
  requestId: 'req-aaaaaaaa',
  projectId: pid(1),
  expectedUpdatedAt: T10,
  ...overrides,
});

const okDelete = async (
  service: Setup['service'],
  input: DeleteProjectInputDto,
): Promise<ProjectDetailDto> => {
  const result: AppResultDto<ProjectDetailDto> = await service.delete(input, TRACE);
  if (!result.ok) throw new Error(`expected ok delete, got ${result.error.code}`);
  return result.data;
};

const okRestore = async (
  service: Setup['service'],
  input: RestoreProjectInputDto,
): Promise<ProjectDetailDto> => {
  const result: AppResultDto<ProjectDetailDto> = await service.restore(input, TRACE);
  if (!result.ok) throw new Error(`expected ok restore, got ${result.error.code}`);
  return result.data;
};

// delete/restore 仅触及 update/audit/receipt 三处写入（无 profile 切换、无 analytics）
const DELETE_RESTORE_WRITE_FAULTS: readonly (readonly [string, ProjectWriteFault])[] = [
  ['update project', 'updateProject'],
  ['record audit', 'recordAudit'],
  ['insert receipt', 'insertReceipt'],
];

describe('ProjectService.delete — 软删除聚合与审计（§3.4）', () => {
  it('场景 1 二次确认软删除：deleted_at/updated_at 原子设值 + 1 audit + 0 event + 1 receipt(changed:true)，目录/Profile 零删除', async () => {
    const { service, store, directory } = setup();
    seedSingleProject(store);

    const detail = await okDelete(service, baseMutationInput());

    expect(detail.deletedAt).toBe('2026-08-09T12:00:00.000Z');
    expect(detail.updatedAt).toBe('2026-08-09T12:00:00.000Z');
    expect(store.projects[0]?.deletedAt).toBe('2026-08-09T12:00:00.000Z');
    expect(store.projects[0]?.updatedAt).toBe('2026-08-09T12:00:00.000Z');
    // FormatProfile 不删除：仍 1 条、current 不变
    expect(store.profiles).toHaveLength(1);
    expect(store.profiles[0]?.id).toBe(fid(1));
    expect(store.profiles[0]?.isCurrent).toBe(true);
    expect(detail.currentFormatProfile.id).toBe(fid(1));
    // 审计证据 + 0 analytics + 1 receipt(changed:true)
    expect(store.audit.map((a) => a.action)).toEqual(['PROJECT_DELETED']);
    expect(store.audit[0]?.objectType).toBe('PROJECT');
    expect(store.audit[0]?.objectId).toBe(pid(1));
    expect(store.audit[0]?.traceId).toBe(TRACE);
    expect(store.audit[0]?.occurredAt).toBe('2026-08-09T12:00:00.000Z');
    expect(store.analytics).toHaveLength(0);
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]?.commandName).toBe('DELETE_PROJECT');
    expect(store.receipts[0]?.resultRef.changed).toBe(true);
    expect(store.receipts[0]?.resultRef.formatProfileId).toBe(fid(1));
    // 目录零调用（不删文件/导出/Provider 侧数据）
    expect(directory.prepareCalls).toBe(0);
    expect(directory.cleanupCalls).toBe(0);
  });

  it('陈旧 expectedUpdatedAt → PROJECT_VERSION_CONFLICT(retryable)，项目仍活动', async () => {
    const { service, store } = setup();
    seedSingleProject(store);

    const result = await service.delete(
      baseMutationInput({ expectedUpdatedAt: '2026-08-08T00:00:00.000Z' }),
      TRACE,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PROJECT_VERSION_CONFLICT');
      expect(result.error.retryable).toBe(true);
      expect(result.error.traceId).toBe(TRACE);
    }
    // 项目仍活动（deletedAt null），零新增 audit/receipt
    expect(store.projects[0]?.deletedAt).toBeNull();
    expect(store.audit).toHaveLength(0);
    expect(store.receipts).toHaveLength(0);
  });

  it('重复删除：已软删除项目 → PROJECT_ALREADY_DELETED，零写入', async () => {
    const { service, store } = setup();
    seedDeletedProject(store);

    const result = await service.delete(baseMutationInput(), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_ALREADY_DELETED');
    expect(store.audit).toHaveLength(0);
    expect(store.receipts).toHaveLength(0);
  });

  it('不存在 → PROJECT_NOT_FOUND', async () => {
    const { service } = setup();

    const result = await service.delete(baseMutationInput({ projectId: pid(99) }), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_NOT_FOUND');
  });

  it.each(DELETE_RESTORE_WRITE_FAULTS)(
    '删除失败不产生成功事件：%s 故障 → PROJECT_PERSISTENCE_FAILED，回滚到种子',
    async (_label, fault) => {
      const { service, store } = setup({ faults: singleFault(fault) });
      seedSingleProject(store);

      const result = await service.delete(baseMutationInput(), TRACE);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('PROJECT_PERSISTENCE_FAILED');
      // 回滚到种子：项目仍活动（deletedAt null）、updatedAt 未变、profile 完好、零审计/回执
      expect(store.projects[0]?.deletedAt).toBeNull();
      expect(store.projects[0]?.updatedAt).toBe(T10);
      expect(store.profiles).toHaveLength(1);
      expect(store.profiles[0]?.id).toBe(fid(1));
      expect(store.profiles[0]?.isCurrent).toBe(true);
      expect(store.audit).toHaveLength(0);
      expect(store.receipts).toHaveLength(0);
    },
  );

  it('current 不变性守卫：无 profile 的项目 → PROJECT_PERSISTENCE_FAILED', async () => {
    const { service, store } = setup();
    // 种子项目但不带任何 profile（违反"恰有一个 current"不变性）
    seedProject(store, makeProject({ id: pid(1), updatedAt: T10 }), []);

    const result = await service.delete(baseMutationInput(), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_PERSISTENCE_FAILED');
    expect(store.projects[0]?.deletedAt).toBeNull();
    expect(store.audit).toHaveLength(0);
    expect(store.receipts).toHaveLength(0);
  });
});

describe('ProjectService.restore — 恢复与名称冲突重检（§3.4）', () => {
  it('场景 3 恢复软删除项目：清 deleted_at + 1 audit + 1 receipt(changed:true)，重新出现在活动列表', async () => {
    const { service, store } = setup();
    seedDeletedProject(store);

    const detail = await okRestore(service, baseMutationInput());

    expect(detail.deletedAt).toBeNull();
    expect(detail.updatedAt).toBe('2026-08-09T12:00:00.000Z');
    expect(store.projects[0]?.deletedAt).toBeNull();
    expect(store.projects[0]?.updatedAt).toBe('2026-08-09T12:00:00.000Z');
    expect(store.audit.map((a) => a.action)).toEqual(['PROJECT_RESTORED']);
    expect(store.audit[0]?.objectType).toBe('PROJECT');
    expect(store.audit[0]?.objectId).toBe(pid(1));
    expect(store.analytics).toHaveLength(0);
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]?.commandName).toBe('RESTORE_PROJECT');
    expect(store.receipts[0]?.resultRef.changed).toBe(true);
    // 恢复后重新出现在活动列表
    expect(idsOf(await okList(service, 'ACTIVE'))).toEqual([pid(1)]);
  });

  it('场景 4 恢复时名称冲突：同名活动项目占用 → PROJECT_NAME_CONFLICT，原项目保持软删除', async () => {
    const { service, store } = setup();
    seedDeletedProject(store);
    // 另一活动项目占用同规范化名（默认名"示例项目"，与种子的 pid(1) 相同）
    seedProject(store, makeProject({ id: pid(2), name: '示例项目', updatedAt: T11 }), [
      makeFormatProfile({ id: fid(2), projectId: pid(2), versionNo: 1 }),
    ]);

    const result = await service.restore(baseMutationInput(), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_NAME_CONFLICT');
    // 原项目保持软删除（deletedAt 不变）、不自动改名、零审计/回执
    expect(store.projects[0]?.deletedAt).toBe(T11);
    expect(store.projects[0]?.name).toBe('示例项目');
    expect(store.audit).toHaveLength(0);
    expect(store.receipts).toHaveLength(0);
  });

  it('重复恢复：活动（未删除）项目 → PROJECT_NOT_DELETED，零写入', async () => {
    const { service, store } = setup();
    seedSingleProject(store);

    const result = await service.restore(baseMutationInput(), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_NOT_DELETED');
    expect(store.audit).toHaveLength(0);
    expect(store.receipts).toHaveLength(0);
  });

  it('不存在 → PROJECT_NOT_FOUND', async () => {
    const { service } = setup();

    const result = await service.restore(baseMutationInput({ projectId: pid(99) }), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('陈旧 expectedUpdatedAt → PROJECT_VERSION_CONFLICT(retryable)，项目仍软删除', async () => {
    const { service, store } = setup();
    seedDeletedProject(store);

    const result = await service.restore(
      baseMutationInput({ expectedUpdatedAt: '2026-08-08T00:00:00.000Z' }),
      TRACE,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PROJECT_VERSION_CONFLICT');
      expect(result.error.retryable).toBe(true);
    }
    expect(store.projects[0]?.deletedAt).toBe(T11);
    expect(store.audit).toHaveLength(0);
    expect(store.receipts).toHaveLength(0);
  });

  it.each(DELETE_RESTORE_WRITE_FAULTS)(
    '恢复失败不产生成功事件：%s 故障 → PROJECT_PERSISTENCE_FAILED，回滚（项目仍软删除）',
    async (_label, fault) => {
      const { service, store } = setup({ faults: singleFault(fault) });
      seedDeletedProject(store);

      const result = await service.restore(baseMutationInput(), TRACE);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('PROJECT_PERSISTENCE_FAILED');
      // 回滚：项目仍软删除、updatedAt 未变、零审计/回执
      expect(store.projects[0]?.deletedAt).toBe(T11);
      expect(store.projects[0]?.updatedAt).toBe(T10);
      expect(store.audit).toHaveLength(0);
      expect(store.receipts).toHaveLength(0);
    },
  );
});

// ─── §3.5 幂等回执：replay / REQUEST_ID_REUSED / 失败不留回执 / no-op ───────
//
// 范围说明：「同时重复调用共享执行」协调器按 Design §4「Main 内的轻量 requestId 协调器」
// 拆至 §3.6（task 3.6 owns 请求协调器）；DB request_id PK 真并发兜底留 §5。本节覆盖顺序 replay。

describe('ProjectService 幂等回执 replay / REQUEST_ID_REUSED（§3.5）', () => {
  it('CREATE replay：同 requestId+载荷重试返回原项目，不重复 id-gen/prepare/写入（R5-S1）', async () => {
    const { service, store, directory } = setup({ ids: [pid(1), fid(1)] });

    const first = await okCreate(service, baseCreateInput());
    const second = await service.create(baseCreateInput(), TRACE);

    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.id).toBe(pid(1));
      expect(second.data).toEqual(first);
    }
    expect(store.projects).toHaveLength(1);
    expect(store.profiles).toHaveLength(1);
    expect(store.audit).toHaveLength(1);
    expect(store.receipts).toHaveLength(1);
    // replay 在 prepare 之前短路 → 不第二次准备目录
    expect(directory.prepareCalls).toBe(1);
  });

  it('UPDATE replay：同 requestId+载荷重试返回首次结果，不重复版本链/审计/回执', async () => {
    const { service, store } = setup();
    seedSingleProject(store);

    const first = await okUpdate(service, baseUpdateInput({ aspectRatio: '16:9' }));
    const second = await service.update(baseUpdateInput({ aspectRatio: '16:9' }), TRACE);

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data).toEqual(first);
    expect(store.profiles).toHaveLength(2);
    expect(store.audit).toHaveLength(2);
    expect(store.receipts).toHaveLength(1);
  });

  it('DELETE replay：同 requestId+载荷重试，项目仍软删除，不重复审计/回执', async () => {
    const { service, store } = setup();
    seedSingleProject(store);

    await okDelete(service, baseMutationInput());
    const second = await service.delete(baseMutationInput(), TRACE);

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.deletedAt).toBe('2026-08-09T12:00:00.000Z');
    expect(store.projects[0]?.deletedAt).toBe('2026-08-09T12:00:00.000Z');
    expect(store.audit).toHaveLength(1);
    expect(store.receipts).toHaveLength(1);
  });

  it('RESTORE replay：同 requestId+载荷重试，项目仍活动，不重复审计/回执', async () => {
    const { service, store } = setup();
    seedDeletedProject(store);

    await okRestore(service, baseMutationInput());
    const second = await service.restore(baseMutationInput(), TRACE);

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.deletedAt).toBeNull();
    expect(store.projects[0]?.deletedAt).toBeNull();
    expect(store.audit).toHaveLength(1);
    expect(store.receipts).toHaveLength(1);
  });

  it('CREATE 不同载荷同 requestId → REQUEST_ID_REUSED，不重复 prepare/写入（R5-S2）', async () => {
    const { service, store, directory } = setup({ ids: [pid(1), fid(1)] });

    await okCreate(service, baseCreateInput());
    const second = await service.create(baseCreateInput({ name: '另一个名字' }), TRACE);

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('REQUEST_ID_REUSED');
    expect(store.projects).toHaveLength(1);
    // REQUEST_ID_REUSED 同样在 prepare 之前短路
    expect(directory.prepareCalls).toBe(1);
  });

  it('UPDATE 不同载荷同 requestId → REQUEST_ID_REUSED，无额外写入', async () => {
    const { service, store } = setup();
    seedSingleProject(store);

    await okUpdate(service, baseUpdateInput({ name: '名字A' }));
    const second = await service.update(baseUpdateInput({ name: '名字B' }), TRACE);

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('REQUEST_ID_REUSED');
    expect(store.profiles).toHaveLength(1);
    expect(store.audit).toHaveLength(1);
    expect(store.receipts).toHaveLength(1);
  });

  it('跨命令复用 requestId → REQUEST_ID_REUSED（commandName 是身份三元组一部分）', async () => {
    const { service, store } = setup({ ids: [pid(1), fid(1)] });

    await okCreate(service, baseCreateInput());
    // create 已绑定 requestId='req-aaaaaaaa'(CREATE_PROJECT)；delete 同 requestId 但 commandName 不同
    const second = await service.delete(baseMutationInput(), TRACE);

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('REQUEST_ID_REUSED');
    expect(store.projects[0]?.deletedAt).toBeNull();
    expect(store.receipts).toHaveLength(1);
  });

  it('CREATE 失败不留回执 → 同 requestId 可安全重试（R5-S3 / Design §4 失败事务不留回执）', async () => {
    // 失败环境：insertProject 故障 → 事务回滚，零回执
    const fail = setup({ ids: [pid(1), fid(1)], faults: singleFault('insertProject') });
    const failed = await fail.service.create(baseCreateInput(), TRACE);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('PROJECT_PERSISTENCE_FAILED');
    expect(fail.store.receipts).toHaveLength(0);

    // 清洁环境同 requestId 重试：无回执 → 非重放/非 REUSED → 正常执行
    //（两 setup 模拟「失败回滚 → 清障 → 同 requestId 重试」，语义等价单 store）
    const retry = setup({ ids: [pid(1), fid(1)] });
    const result = await retry.service.create(baseCreateInput(), TRACE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.id).toBe(pid(1));
    expect(retry.store.projects).toHaveLength(1);
    expect(retry.store.receipts).toHaveLength(1);
  });

  it('UPDATE no-op receipt replay：无变更载荷重试仍 replay，updatedAt 不动（Design §6）', async () => {
    const { service, store } = setup();
    seedSingleProject(store);

    await okUpdate(service, baseUpdateInput());
    const second = await service.update(baseUpdateInput(), TRACE);

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.updatedAt).toBe(T10);
    expect(store.projects[0]?.updatedAt).toBe(T10);
    expect(store.audit).toHaveLength(0);
    expect(store.receipts).toHaveLength(1);
  });
});

describe('ProjectService 错误归一化（§3.6）', () => {
  // 对抗性异常载荷：携带 SQL / 绝对路径 / 堆栈片段，验证归一化后 AppError 不泄漏（Design §9；§3.7 全矩阵）
  const adversarialFault = (fault: ProjectWriteFault): ProjectWriteFaults => {
    const f: ProjectWriteFaults = {};
    f[fault] = new Error('SELECT * FROM projects; at C:\\Users\\leak\\app\\db.ts:42');
    return f;
  };
  const LEAK = /SELECT|leak|db\.ts|Users/i;

  it('create 写入故障 → PROJECT_PERSISTENCE_FAILED(retryable)，固定 message 不泄漏 SQL/路径/堆栈', async () => {
    const { service } = setup({ faults: adversarialFault('insertProject') });

    const result = await service.create(baseCreateInput(), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PROJECT_PERSISTENCE_FAILED');
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toBe('项目创建失败，请重试');
      expect(result.error.userAction).toBeNull();
      expect(result.error.fieldErrors).toBeNull();
      expect(result.error.message).not.toMatch(LEAK);
    }
  });

  it('update 写入故障 → PROJECT_PERSISTENCE_FAILED(retryable)，固定 message 不泄漏', async () => {
    const { service, store } = setup({ faults: adversarialFault('updateProject') });
    seedSingleProject(store);

    // name 变更使 update 走入写入路径（no-op 会跳过 projects.update，触发不到故障）
    const result = await service.update(baseUpdateInput({ name: '改名' }), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PROJECT_PERSISTENCE_FAILED');
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toBe('项目更新失败，请重试');
      expect(result.error.message).not.toMatch(LEAK);
    }
  });

  it('directory prepare 故障（含 SQL/路径/堆栈）→ PROJECT_DIRECTORY_UNAVAILABLE(retryable)，不泄漏', async () => {
    const { service, store } = setup({
      prepareError: new Error('SELECT * FROM projects; at C:\\Users\\leak\\app\\db.ts:42'),
    });

    const result = await service.create(baseCreateInput(), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PROJECT_DIRECTORY_UNAVAILABLE');
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toBe('项目目录不可用，请检查存储后重试');
      expect(result.error.message).not.toMatch(LEAK);
    }
    expect(store.projects).toHaveLength(0);
  });

  // delete/restore 共用同一 .catch(persistenceFailed) 模式；delete 代表该路径，restore 同形（§3.7 全覆盖）
  it('delete 写入故障 → PROJECT_PERSISTENCE_FAILED(retryable)，固定 message 不泄漏', async () => {
    const { service, store } = setup({ faults: adversarialFault('updateProject') });
    seedSingleProject(store);

    const result = await service.delete(baseMutationInput(), TRACE);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PROJECT_PERSISTENCE_FAILED');
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toBe('项目删除失败，请重试');
      expect(result.error.message).not.toMatch(LEAK);
    }
  });
});
