/** Project 本地分析事件名（Design §6）。 */
export type AnalyticsEventName = 'project_created' | 'dialogue_mode_selected';

/**
 * Application 记录的本地分析事件（Design §6）。
 *
 * properties 只承载枚举与来源等安全字段（如 dialogueRenderMode、source=PROJECT_SETTINGS），
 * 不含项目名称或用户内容。session_id 属于持久化细节，由 Adapter 写入，不进入本结构。
 */
export interface AnalyticsEvent {
  readonly projectId: string;
  readonly eventName: AnalyticsEventName;
  readonly properties: Readonly<Record<string, string>>;
  readonly occurredAt: string;
}

/**
 * 本地分析事件写入契约（Design §6）。
 *
 * 在 {@link ProjectUnitOfWorkPort} 事务内写入，与业务变更原子提交；不自行提交。
 * V1 不发送远程产品分析或崩溃遥测。
 */
export interface AnalyticsRepository {
  record(event: AnalyticsEvent): Promise<void>;
}
