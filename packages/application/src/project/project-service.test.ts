import { describe, expect, it } from 'vitest';

import type { AppResultDto, ProjectDetailDto, ProjectListResultDto } from '@jingxu/contracts';

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

/** 合法系统 ID（满足 cursor ID_RE 12–64）。 */
const pid = (n: number): string => `proj${String(n).padStart(12, '0')}`;
const fid = (n: number): string => `fp${String(n).padStart(13, '0')}`;
const TRACE = 'trace-aaaaaaaa';
const T10 = '2026-08-09T10:00:00.000Z';
const T11 = '2026-08-09T11:00:00.000Z';

interface Setup {
  readonly service: ReturnType<typeof createProjectService>;
  readonly store: ReturnType<typeof createInMemoryStore>;
}

const setup = (): Setup => {
  const store = createInMemoryStore();
  const service = createProjectService({
    unitOfWork: createInMemoryUnitOfWork(createInMemoryRepositories(store)),
    clock: createFakeClock(Date.parse('2026-08-09T12:00:00.000Z')),
    idGenerator: createFakeIdGenerator(),
    hasher: createFakeStableHasher(),
    directory: createFakeDirectoryPort(),
  });
  return { service, store };
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
