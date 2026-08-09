import type { AspectRatio, Project } from '@jingxu/domain';
import type { ProjectListScope } from '@jingxu/contracts';

/**
 * keyset 分页的排序定位点（Design §7）。
 *
 * 列表按 `updated_at DESC, id DESC` 稳定排序；游标携带上一页最后一条的 updatedAt/id，
 * 避免使用 OFFSET。after 为 null 表示请求第一页。
 */
export interface ProjectKeyset {
  readonly updatedAt: string;
  readonly id: string;
}

/**
 * 活动项目名称引用，用于 Application 层的唯一性冲突检查（Design §3）。
 *
 * Repository 只读取活动项目的 id 与原始 name；Application 用 normalizeNameKey 生成
 * 确定性冲突键比对。SQLite 内建 lower() 无法可靠复现 Unicode/JS NFC 规则，因此冲突
 * 判定不依赖数据库。excludeProjectId 为 null 表示不排除（创建检查），非 null 表示
 * 排除自身（恢复检查）。
 */
export interface ProjectNameRef {
  readonly projectId: string;
  readonly name: string;
}

/**
 * 列表项：Project 聚合 + 当前 FormatProfile 的画幅摘要（Design §7）。
 *
 * 对应 ProjectSummaryDto 所需字段；Repository 不返回 SQL、dataRootRel 或审计 metadata。
 */
export interface ProjectListItem {
  readonly project: Project;
  readonly currentAspectRatio: AspectRatio;
}

/** 无搜索的 keyset 分页查询输入。 */
export interface ProjectListQuery {
  readonly scope: ProjectListScope;
  readonly limit: number;
  /** 上一页最后一条的定位点；null 表示第一页。 */
  readonly after: ProjectKeyset | null;
}

/** 无搜索分页结果。nextAfter 为 null 表示无下一页。 */
export interface ProjectListPage {
  readonly items: readonly ProjectListItem[];
  readonly nextAfter: ProjectKeyset | null;
  readonly truncated: boolean;
}

/**
 * 名称搜索的有界扫描输入（Design §7）。
 *
 * Repository 在硬上限内按 scope + after 扫描候选，不做名称过滤；Application 对返回
 * 候选用 normalizeNameKey 做 contains 过滤、排序与 limit 截取。truncated=true 表示
 * 触及硬上限，Renderer 需向用户区分“仍有更多”与“已全部加载”。
 */
export interface ProjectSearchScanQuery {
  readonly scope: ProjectListScope;
  readonly after: ProjectKeyset | null;
  readonly hardLimit: number;
}

/** 名称搜索扫描结果。 */
export interface ProjectSearchScan {
  readonly candidates: readonly ProjectListItem[];
  readonly truncated: boolean;
}

/**
 * Project 聚合的持久化访问契约（Design §1、§6、§7）。
 *
 * 所有方法在 {@link ProjectUnitOfWorkPort} 的事务内调用，Repository 不自行提交或回滚
 * （AGENTS §11.2）。方法返回纯领域实体或 null，不泄漏 Row、Statement、连接或 SQL。
 */
export interface ProjectRepository {
  /** 按 id 与 scope 查询单个 Project；不存在返回 null。 */
  findById(id: string, scope: ProjectListScope): Promise<Project | null>;
  /** 读取活动项目的 id 与原始名称，用于 Application 名称冲突检查。 */
  findActiveNameRefs(excludeProjectId: string | null): Promise<readonly ProjectNameRef[]>;
  /** 无搜索的稳定 keyset 分页，不使用 OFFSET（Design §7）。 */
  listPage(query: ProjectListQuery): Promise<ProjectListPage>;
  /** 名称搜索的有界扫描；过滤与分页由 Application 完成（Design §7）。 */
  scanForSearch(query: ProjectSearchScanQuery): Promise<ProjectSearchScan>;
  /** 插入新 Project 聚合。 */
  insert(project: Project): Promise<void>;
  /**
   * 按乐观并发条件更新 Project（含元数据变更、软删除、恢复）。
   * @returns true 命中 expectedUpdatedAt；false 表示版本冲突或不存在。
   */
  update(project: Project, expectedUpdatedAt: string): Promise<boolean>;
}
