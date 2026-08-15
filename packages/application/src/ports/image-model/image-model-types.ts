import type { ModelErrorCode } from '../text-model/text-model-types';

/**
 * 图片模型 Port 类型（shot-first-frame-image-generation design D2）。
 *
 * Port 同时容忍同步与异步 Provider API：submit() 返回终态结果引用（同步）或
 * providerTaskId（异步）。火山方舟 images/generations 为同步形态——POST 直接
 * 返回终态、无任务轮询接口（0.2 官方核对，docs/82379/1541523）；该形态下
 * poll() 恒即时 SUCCEEDED，providerTaskId 语义退化为调用证据引用。
 */

/** 参考图字节：业务层从内容寻址存储读出后交给 Adapter；Adapter 负责编码为 data URI。 */
export interface ImageReferencePayload {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

/**
 * 单图生成请求（业务层组装；Adapter 映射到具体 Provider 接口）。
 *
 * 方舟无 `n` 批量参数：N 候选 = N 次独立 submit（design D6-1），每次各记一条
 * model_invocations。prompt 由服务层按镜头创意字段 + STORY_BIBLE + FormatProfile
 * 组装完成，Adapter 不做业务拼接。
 */
export interface ImageGenerationRequest {
  readonly invocationId: string;
  readonly modelId: string;
  readonly prompt: string;
  /** 显式 WxH；服务层按 FormatProfile 画幅映射解析（总像素合法区间见 0.2 结论 8）。 */
  readonly size: Readonly<{ height: number; width: number }>;
  readonly referenceImages: readonly ImageReferencePayload[];
}

/** Provider 上报用量（方舟 usage：generated_images / output_tokens）；未知为 null。 */
export interface ImageGenerationUsage {
  readonly generatedImages: number | null;
  readonly outputTokens: number | null;
}

/**
 * 终态结果引用：下载段的唯一句柄。
 *
 * url 为 Provider 结果 URL（24h 有效），允许持久化用于重启后恢复下载段；
 * 不含凭据或 Authorization。宽高来自 Provider 报告，未知为 null。
 */
export interface ImageResultRef {
  readonly height: number | null;
  readonly providerRequestId: string | null;
  readonly url: string;
  readonly width: number | null;
}

/** submit() 的双形态返回：同步终态结果 或 异步任务句柄（须先持久化再轮询）。 */
export type ImageTaskSubmission =
  | Readonly<{ kind: 'SYNC'; result: ImageResultRef; usage: ImageGenerationUsage }>
  | Readonly<{ kind: 'ASYNC'; providerTaskId: string }>;

/** poll() 的任务状态判别联合。 */
export type ImageTaskStatus =
  | Readonly<{ state: 'PENDING' }>
  | Readonly<{ result: ImageResultRef; state: 'SUCCEEDED'; usage: ImageGenerationUsage }>
  | Readonly<{ detail: string | null; errorCode: ModelErrorCode; state: 'FAILED' }>;

/** download() 返回的字节与嗅探格式；宽高以 ImageResultRef / 落库校验为准。 */
export interface ImageDownload {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}
