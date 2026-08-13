/** Project 审计动作（audit_events.action 的 V1 子集，Design §6）。 */
export type AuditAction =
  | 'PROJECT_CREATED'
  | 'PROJECT_UPDATED'
  | 'PROJECT_DELETED'
  | 'PROJECT_RESTORED'
  | 'FORMAT_PROFILE_VERSIONED';

/** 审计对象类型。 */
export type AuditObjectType = 'PROJECT' | 'FORMAT_PROFILE';

/**
 * Application 记录的审计意图（Design §6）。
 *
 * V1 无用户登录，actor 固定 SYSTEM，由 Adapter 写入；本结构只承载 Application 关心的
 * 业务字段，不含 before/after 摘要或 metadata 的基础设施细节。
 */
export interface AuditEntry {
  readonly projectId: string;
  readonly action: AuditAction;
  readonly objectType: AuditObjectType;
  readonly objectId: string;
  readonly traceId: string;
  readonly occurredAt: string;
}

/**
 * 审计写入契约（Design §6）。
 *
 * 在 {@link ProjectUnitOfWorkPort} 事务内写入，与业务变更原子提交；不自行提交。
 */
export interface AuditRepository {
  record(entry: AuditEntry): Promise<void>;
}
