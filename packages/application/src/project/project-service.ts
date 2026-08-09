import type {
  AppResultDto,
  CreateProjectInputDto,
  FormatProfileDto,
  ProjectDetailDto,
  ProjectErrorCode,
  ProjectGetInputDto,
  ProjectListInputDto,
  ProjectListResultDto,
  ProjectSummaryDto,
} from '@jingxu/contracts';
import type { FormatProfile, Project, ProjectNameValidationError } from '@jingxu/domain';
import { createFormatProfileSpec, normalizeNameKey, validateProjectName } from '@jingxu/domain';
import type { Clock, IdGenerator, StableHasher } from '../ports/project/service-dependencies';
import type {
  ProjectDirectoryHandle,
  ProjectDirectoryPort,
} from '../ports/project/project-directory-port';
import type { ProjectKeyset, ProjectListItem } from '../ports/project/project-repository';
import type { ProjectUnitOfWorkPort } from '../ports/project/project-unit-of-work';

import { decodeCursor, encodeCursor } from './project-cursor';

/**
 * 名称搜索的内部扫描硬上限（Design §7）。
 *
 * Repository 在该上限内按 scope + after 扫描候选，Application 再做规范化名称 contains
 * 过滤；触及上限时返回显式截断标志。V1 容量基线内不会触及；超出时通过独立 FTS/索引
 * Change 调整，不在此预建。
 */
const SEARCH_SCAN_HARD_LIMIT = 200;

/**
 * ProjectService 的可注入依赖（Design §1）。
 *
 * 时间、ID、稳定 hash、目录与 UnitOfWork 全部抽象为 Port，由 Main Composition Root
 * 注入生产实现、由测试注入确定性 Fake。traceId 由 IPC 层逐次生成并传入，service 用它
 * 关联同一请求的 AppError 与审计/事件。
 */
export interface ProjectServiceDeps {
  readonly unitOfWork: ProjectUnitOfWorkPort;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly hasher: StableHasher;
  readonly directory: ProjectDirectoryPort;
}

/**
 * Project 用例服务（Design §6、§7）。
 *
 * 方法签名比 IPC `ProjectApi` 多一个 `traceId`：IPC 层（§7）逐次生成 traceId 并传入，
 * service 内用同一 traceId 关联错误与审计。所有读写仅在 {@link ProjectUnitOfWorkPort}
 * 回调内经 Repository 完成，service 不持有连接或事务所有权。
 */
export interface ProjectService {
  /** 按稳定 keyset 分页列出活动/已删除项目，可选规范化名称搜索。 */
  list(input: ProjectListInputDto, traceId: string): Promise<AppResultDto<ProjectListResultDto>>;
  /** 按 scope 取单个项目详情（current FormatProfile + 不含当前的版本历史）。 */
  get(input: ProjectGetInputDto, traceId: string): Promise<AppResultDto<ProjectDetailDto>>;
  /** 原子创建 Project 与首个 current FormatProfile（Design §5、§6）。 */
  create(input: CreateProjectInputDto, traceId: string): Promise<AppResultDto<ProjectDetailDto>>;
}

/** 名称校验失败转用户可读 message（与 fieldErrors.name 共用）。 */
const nameErrorMessage = (error: ProjectNameValidationError): string => {
  switch (error.kind) {
    case 'EMPTY':
      return '项目名称不能为空';
    case 'LEADING_OR_TRAILING_WHITESPACE':
      return '项目名称不能包含首尾空白';
    case 'TOO_LONG':
      return '项目名称不能超过 100 个字符';
  }
};

export const createProjectService = (deps: ProjectServiceDeps): ProjectService => {
  const error = <T>(
    code: ProjectErrorCode,
    message: string,
    traceId: string,
    fieldErrors: Record<string, string> | null = null,
    retryable = false,
  ): AppResultDto<T> => ({
    ok: false,
    error: { code, message, retryable, userAction: null, fieldErrors, traceId },
  });

  const toSummary = (item: ProjectListItem): ProjectSummaryDto => ({
    id: item.project.id,
    name: item.project.name,
    genre: item.project.genre,
    style: item.project.style,
    creationMode: item.project.creationMode,
    dialogueRenderMode: item.project.dialogueRenderMode,
    aspectRatio: item.currentAspectRatio,
    updatedAt: item.project.updatedAt,
    deletedAt: item.project.deletedAt,
  });

  const toFormatProfileDto = (profile: FormatProfile): FormatProfileDto => ({
    id: profile.id,
    projectId: profile.projectId,
    versionNo: profile.versionNo,
    parentId: profile.parentId,
    aspectRatio: profile.spec.aspectRatio,
    width: profile.spec.width,
    height: profile.spec.height,
    fps: profile.spec.fps,
    language: profile.spec.language,
    subtitleSafeArea: profile.spec.subtitleSafeArea,
    isCurrent: profile.isCurrent,
    createdAt: profile.createdAt,
  });

  /** 构造详情：current + 不含当前的版本历史（get/create 共用）。 */
  const buildProjectDetail = (
    project: Project,
    current: FormatProfile,
    history: readonly FormatProfile[],
  ): ProjectDetailDto => ({
    id: project.id,
    name: project.name,
    genre: project.genre,
    style: project.style,
    creationMode: project.creationMode,
    dialogueRenderMode: project.dialogueRenderMode,
    // V1 固定 LOCAL_DEMO（Design §1）；domain 枚举对齐 0001 CHECK 较宽，读路径按 invariant 收窄
    deploymentMode: project.deploymentMode as 'LOCAL_DEMO',
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    deletedAt: project.deletedAt,
    currentFormatProfile: toFormatProfileDto(current),
    formatProfileHistory: history.map(toFormatProfileDto),
  });

  const list: ProjectService['list'] = (input, traceId) =>
    deps.unitOfWork.run(async (repositories) => {
      const searchHash =
        input.search === null
          ? null
          : deps.hasher.hash({ scope: input.scope, search: input.search });

      let after: ProjectKeyset | null = null;
      if (input.cursor !== null) {
        const decoded = decodeCursor(input.cursor, { scope: input.scope, searchHash });
        if (!decoded.ok) return error('IPC_INVALID_REQUEST', '请求参数无效或游标已失效', traceId);
        after = { updatedAt: decoded.payload.updatedAt, id: decoded.payload.id };
      }

      const encodeNext = (nextAfter: ProjectKeyset | null): string | null =>
        nextAfter === null
          ? null
          : encodeCursor({
              v: 1,
              updatedAt: nextAfter.updatedAt,
              id: nextAfter.id,
              scope: input.scope,
              searchHash,
            });

      if (input.search === null) {
        const page = await repositories.projects.listPage({
          scope: input.scope,
          limit: input.limit,
          after,
        });
        return {
          ok: true,
          data: {
            items: page.items.map(toSummary),
            nextCursor: encodeNext(page.nextAfter),
            truncated: page.truncated,
          },
        };
      }

      const scan = await repositories.projects.scanForSearch({
        scope: input.scope,
        after,
        hardLimit: SEARCH_SCAN_HARD_LIMIT,
      });
      const needle = normalizeNameKey(input.search);
      const matched = scan.candidates.filter((c) =>
        normalizeNameKey(c.project.name).includes(needle),
      );
      const limited = matched.slice(0, input.limit);
      const hasMore = matched.length > input.limit;
      const last = limited[limited.length - 1];
      const nextAfter =
        (hasMore || scan.truncated) && last !== undefined
          ? { updatedAt: last.project.updatedAt, id: last.project.id }
          : null;

      return {
        ok: true,
        data: {
          items: limited.map(toSummary),
          nextCursor: encodeNext(nextAfter),
          truncated: scan.truncated,
        },
      };
    });

  const get: ProjectService['get'] = (input, traceId) =>
    deps.unitOfWork.run(async (repositories) => {
      const project = await repositories.projects.findById(input.projectId, input.scope);
      if (project === null) return error('PROJECT_NOT_FOUND', '项目不存在', traceId);

      const profiles = await repositories.formatProfiles.findAllByProject(input.projectId);
      const current = profiles.find((fp) => fp.isCurrent);
      if (current === undefined) {
        return error('PROJECT_PERSISTENCE_FAILED', '项目数据异常', traceId);
      }
      const history = profiles.filter((fp) => !fp.isCurrent);
      return { ok: true, data: buildProjectDetail(project, current, history) };
    });

  const create: ProjectService['create'] = async (input, traceId) => {
    // 名称语义校验：zod 已在 IPC 拦空与 100，这里补首尾空白与 code point 计数
    const nameError = validateProjectName(input.name);
    if (nameError !== null) {
      const message = nameErrorMessage(nameError);
      return error<ProjectDetailDto>('IPC_INVALID_REQUEST', message, traceId, { name: message });
    }

    // 目录准备在事务外完成（Design §5）；projectId 先派生以供目录与事务共用
    const projectId = deps.idGenerator.newId();
    let handle: ProjectDirectoryHandle;
    try {
      handle = await deps.directory.prepare(projectId);
    } catch {
      return error('PROJECT_DIRECTORY_UNAVAILABLE', '项目目录不可用，请检查存储后重试', traceId);
    }

    try {
      return await deps.unitOfWork.run(async (repositories) => {
        // 单一写连接内的名称冲突检查：不依赖数据库 lower()，按 normalizeNameKey 比对
        const normalizedNew = normalizeNameKey(input.name);
        const refs = await repositories.projects.findActiveNameRefs(null);
        if (refs.some((ref) => normalizeNameKey(ref.name) === normalizedNew)) {
          return error<ProjectDetailDto>('PROJECT_NAME_CONFLICT', '项目名称已被占用', traceId, {
            name: '该名称已存在，请更换',
          });
        }

        const formatProfileId = deps.idGenerator.newId();
        const nowIso = new Date(deps.clock.now()).toISOString();
        const project: Project = {
          id: projectId,
          name: input.name,
          genre: input.genre,
          style: input.style,
          creationMode: input.creationMode,
          dialogueRenderMode: input.dialogueRenderMode,
          deploymentMode: 'LOCAL_DEMO',
          createdAt: nowIso,
          updatedAt: nowIso,
          deletedAt: null,
        };
        const profile: FormatProfile = {
          id: formatProfileId,
          projectId,
          versionNo: 1,
          parentId: null,
          spec: createFormatProfileSpec(input.aspectRatio, input.subtitleSafeArea),
          isCurrent: true,
          createdAt: nowIso,
        };

        // 单事务顺序写入：任一步 reject → unitOfWork 回滚全部，保证零部分结果
        await repositories.projects.insert(project);
        await repositories.formatProfiles.insert(profile);
        await repositories.audit.record({
          projectId,
          action: 'PROJECT_CREATED',
          objectType: 'PROJECT',
          objectId: projectId,
          traceId,
          occurredAt: nowIso,
        });
        await repositories.analytics.record({
          projectId,
          eventName: 'project_created',
          properties: { source: 'PROJECT_SETTINGS' },
          occurredAt: nowIso,
        });
        await repositories.analytics.record({
          projectId,
          eventName: 'dialogue_mode_selected',
          properties: {
            dialogueRenderMode: input.dialogueRenderMode,
            source: 'PROJECT_SETTINGS',
          },
          occurredAt: nowIso,
        });

        // 幂等回执：只写不读，replay/REQUEST_ID_REUSED 逻辑留 §3.5；payloadSha256 覆盖
        // 全部业务字段（不含 requestId），与 §3.5 幂等判定一致
        const payloadSha256 = deps.hasher.hash({
          name: input.name,
          genre: input.genre,
          style: input.style,
          creationMode: input.creationMode,
          dialogueRenderMode: input.dialogueRenderMode,
          aspectRatio: input.aspectRatio,
          subtitleSafeArea: input.subtitleSafeArea,
        });
        await repositories.receipts.insert({
          requestId: input.requestId,
          commandName: 'CREATE_PROJECT',
          payloadSha256,
          projectId,
          resultRef: { projectId, formatProfileId, updatedAt: nowIso, changed: true },
          traceId,
          committedAt: nowIso,
        });

        return { ok: true, data: buildProjectDetail(project, profile, []) };
      });
    } catch {
      // 事务回滚后补偿清理本次新建目录；补偿失败仅脱敏 WARN，不影响返回的安全错误（Design §5）
      try {
        await deps.directory.cleanupIfCreatedEmpty(handle);
      } catch {
        /* 不向 Renderer 暴露 fs 细节（§3.7 进一步覆盖注入测试） */
      }
      return error('PROJECT_PERSISTENCE_FAILED', '项目创建失败，请重试', traceId);
    }
  };

  return { list, get, create };
};
