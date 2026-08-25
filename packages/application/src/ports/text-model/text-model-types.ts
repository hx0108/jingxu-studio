import type { ScriptStage } from '@jingxu/contracts';

/**
 * 归一化的文本模型错误码（TECH_DESIGN v1.1 §6、§11；PRD v1.4 §9.4）。
 *
 * Provider 专有错误在 Adapter 边界映射为这些稳定 code；JobRunner 据此决定是否
 * transport retry，IPC 边界再映射为 AppError。是否可重试由 §9.4.2 重试策略与
 * 调用上下文共同决定，而非由 code 单独决定。
 */
export type ModelErrorCode =
  | 'MODEL_CREDENTIAL_INVALID'
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_PROVIDER_ERROR'
  | 'MODEL_MODEL_UNAVAILABLE'
  | 'MODEL_NETWORK_ERROR'
  | 'MODEL_TIMEOUT'
  | 'MODEL_INVALID_RESPONSE'
  | 'MODEL_CONTENT_REJECTED'
  | 'MODEL_CONTEXT_LIMIT'
  | 'MODEL_INPUT_TOO_LARGE'
  | 'MODEL_CANCELLED'
  /** 图片切片新增（design 0.2）：结果 URL 失效/不可得——下载段不可重试，需重新生成。 */
  | 'MODEL_RESULT_UNAVAILABLE'
  | 'MODEL_UNKNOWN';

/**
 * 归一化模型错误：稳定 code + 脱敏 detail + 可选 Provider 请求 ID。
 *
 * 严禁携带 API Key、Authorization header、百炼原始错误体或完整响应。
 */
export interface NormalizedModelError {
  readonly code: ModelErrorCode;
  readonly detail: string | null;
  readonly providerRequestId: string | null;
  readonly retryable: boolean;
  readonly userAction: string | null;
}

/** 凭据连通性检查结果；失败时返回稳定 code，不暴露明文 Key。 */
export type CredentialCheck =
  | Readonly<{ ok: true }>
  | Readonly<{ detail: string | null; errorCode: ModelErrorCode; ok: false }>;

/**
 * 文本生成请求（TECH_DESIGN v1.1 §6.1）。
 *
 * 业务层只构造该 DTO；Adapter 负责映射到具体 Provider 接口。
 */
export interface TextGenerationRequest {
  readonly candidateSchemaId: string;
  readonly finalSchemaId: string;
  readonly invocationId: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly promptTemplateVersion: string;
  readonly stage: ScriptStage;
  readonly systemPrompt: string;
  readonly userPayload: unknown;
}

/** Provider 用量；未知时为 null。 */
export interface TextGenerationUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/**
 * 文本生成结果（TECH_DESIGN v1.1 §6.1）。
 *
 * 只含业务层需要的归一化字段；不含百炼 choices 或 HTTP header。
 */
export interface TextGenerationResult {
  readonly finishReason: string | null;
  readonly modelReported: string | null;
  readonly providerRequestId: string | null;
  readonly rawText: string;
  readonly usage: TextGenerationUsage;
}
