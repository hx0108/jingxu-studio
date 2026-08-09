import type {
  AppResultDto,
  FormatProfileDto,
  ProjectDetailDto,
  ProjectGetInputDto,
  ProjectListInputDto,
  ProjectListResultDto,
  ProjectSummaryDto,
} from '@jingxu/contracts';
import type { FormatProfile } from '@jingxu/domain';
import { normalizeNameKey } from '@jingxu/domain';
import type { Clock, IdGenerator, StableHasher } from '../ports/project/service-dependencies';
import type { ProjectDirectoryPort } from '../ports/project/project-directory-port';
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
}

export const createProjectService = (deps: ProjectServiceDeps): ProjectService => {
  const error = <T>(
    code: 'PROJECT_NOT_FOUND' | 'IPC_INVALID_REQUEST' | 'PROJECT_PERSISTENCE_FAILED',
    message: string,
    traceId: string,
  ): AppResultDto<T> => ({
    ok: false,
    error: { code, message, retryable: false, userAction: null, fieldErrors: null, traceId },
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

      return {
        ok: true,
        data: {
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
        },
      };
    });

  return { list, get };
};
