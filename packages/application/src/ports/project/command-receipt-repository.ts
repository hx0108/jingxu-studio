/** Project 写命令名（Design §4 command_receipts.command_name 合法枚举）。 */
export type CommandName =
  'CREATE_PROJECT' | 'UPDATE_PROJECT' | 'DELETE_PROJECT' | 'RESTORE_PROJECT';

/**
 * 回执的安全结果引用（Design §4 result_ref_json）。
 *
 * 只保存 Project/FormatProfile ID 与提交 revision 等安全引用，不保存名称、genre/style、
 * 目录或完整命令载荷。changed=false 标记 no-op 回执，使 Application 重建结果时不误报
 * 成功变更（Design §6）。
 */
export interface CommandReceiptResultRef {
  readonly projectId: string;
  readonly formatProfileId: string;
  readonly updatedAt: string;
  readonly changed: boolean;
}

/**
 * 命令幂等回执（Design §4）。
 *
 * requestId 为主键；payloadSha256 与 commandName 共同判定同 requestId 是否复用。
 * projectId 允许 null 以匹配 command_receipts.project_id 的可空外键。
 */
export interface CommandReceipt {
  readonly requestId: string;
  readonly commandName: CommandName;
  readonly payloadSha256: string;
  readonly projectId: string | null;
  readonly resultRef: CommandReceiptResultRef;
  readonly traceId: string;
  readonly committedAt: string;
}

/**
 * 命令幂等回执的持久化访问契约（Design §4）。
 *
 * 所有方法在 {@link ProjectUnitOfWorkPort} 事务内调用，与业务、审计、Analytics 在同一
 * 事务提交。Repository 负责结构化 resultRef 与 JSON 列之间的序列化，不向 Application
 * 暴露 result_ref_json 原文。
 */
export interface CommandReceiptRepository {
  /** 按 requestId 查询已提交回执；不存在返回 null。 */
  findByRequestId(requestId: string): Promise<CommandReceipt | null>;
  /** 写入回执，与业务变更原子提交（Design §4）。 */
  insert(receipt: CommandReceipt): Promise<void>;
}
