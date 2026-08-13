import type { CredentialRef } from './credential-types';

/**
 * 凭据 Application Port（AGENTS.md §13.2、TECH_DESIGN v1.1 §3.3）。
 *
 * 明文 API Key 只在实现该 Port 的 Main 凭据 Adapter（Electron safeStorage）与
 * 调用它的 TextModelAdapter 边界内流转；Application 业务对象、Renderer、日志、
 * 诊断包与导出包均不得持有明文 Key。safeStorage 不可用时 saveCredential MUST
 * 失败，MUST NOT 降级为明文。
 */
export interface CredentialPort {
  /** safeStorage 是否可用；不可用时 saveCredential 失败，不降级明文。 */
  isAvailable(): boolean;
  /** 加密保存明文 Key，返回不含明文的引用。 */
  saveCredential(plaintext: string): Promise<CredentialRef>;
  /** 解密读取明文 Key；仅供受信 Adapter 在基础设施边界使用。 */
  loadCredential(id: string): Promise<string>;
  /** 删除密文与引用。 */
  deleteCredential(id: string): Promise<void>;
}
