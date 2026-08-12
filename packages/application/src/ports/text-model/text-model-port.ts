import type {
  CredentialCheck,
  NormalizedModelError,
  TextGenerationRequest,
  TextGenerationResult,
} from './text-model-types';

/**
 * 文本模型 Application Port（TECH_DESIGN v1.1 §6.1）。
 *
 * Application/Domain 只依赖该接口与 NormalizedModelError；百炼 choices、HTTP
 * header、Authorization 或 Provider 专有错误结构只允许存在于实现该 Port 的
 * Adapter（如 QwenTextModelAdapter / MockTextModelAdapter）。
 */
export interface TextModelPort {
  /** 校验凭据可用性；不把明文 Key 暴露给业务层。 */
  validateCredential(): Promise<CredentialCheck>;
  /**
   * 执行一次文本生成调用。signal 取消时 SHALL 归一化为 MODEL_CANCELLED。
   * 每次真实 Provider 请求对应一条独立 ModelInvocation。
   */
  generate(request: TextGenerationRequest, signal: AbortSignal): Promise<TextGenerationResult>;
  /** 将 Provider 专有错误归一化为稳定 NormalizedModelError，脱敏后返回。 */
  normalizeError(error: unknown): NormalizedModelError;
}
