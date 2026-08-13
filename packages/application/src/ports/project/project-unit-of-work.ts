import type { AnalyticsRepository } from './analytics-repository';
import type { AuditRepository } from './audit-repository';
import type { CommandReceiptRepository } from './command-receipt-repository';
import type { FormatProfileRepository } from './format-profile-repository';
import type { ProjectRepository } from './project-repository';

/**
 * 单一 Project 事务内可访问的全部 Repository（Design §1）。
 *
 * 五个 Repository 共享同一事务连接；Application 在 {@link ProjectUnitOfWorkPort#run}
 * 回调内通过本聚合完成读与写。
 */
export interface ProjectRepositories {
  readonly projects: ProjectRepository;
  readonly formatProfiles: FormatProfileRepository;
  readonly receipts: CommandReceiptRepository;
  readonly audit: AuditRepository;
  readonly analytics: AnalyticsRepository;
}

/**
 * Project 读写事务边界（Design §1、§5；AGENTS §11.2）。
 *
 * 在单一 `BEGIN IMMEDIATE` 事务内执行 work：work 正常返回即提交，抛出即回滚。Repository
 * 方法不自行提交或回滚——事务所有权始终留在本接口的回调边界。事务内不得执行目录准备、
 * 网络请求或长时间文件 I/O（Design §5、AGENTS §11.2）。
 */
export interface ProjectUnitOfWorkPort {
  run<T>(work: (repositories: ProjectRepositories) => Promise<T>): Promise<T>;
}
