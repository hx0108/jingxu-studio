/**
 * 凭据引用（AGENTS.md §13.2、TECH_DESIGN v1.1 §3.3）。
 *
 * SQLite 与 Application 只持有该引用与验证元数据；明文密钥独立保存于 Electron
 * safeStorage 加密的存储中，不进入该对象、日志、诊断包或导出包。
 */
export interface CredentialRef {
  readonly createdAt: string;
  readonly id: string;
  readonly kind: 'API_KEY';
  readonly last4: string | null;
}
