import type {
  ImageDownload,
  ImageGenerationUsage,
  ImageRawResponse,
  ImageResultRef,
  ImageTaskStatus,
  ImageTaskSubmission,
  ModelCallEvidence,
} from '../image-model/image-model-types';

/**
 * 视频模型 Port 类型（shot-video-generation design A3）。
 *
 * 提交/轮询/下载/证据形态与图片域结构同构（媒体通用形态，别名复用不另立
 * 结构）；请求载荷与结果引用为视频专属（首帧字节 + 档位时长；实际时长回传）。
 */

/** 首帧图生视频请求（i2v）：已选首帧字节 + 确定性派生提示词 + 分辨率 + 档位时长。 */
export interface VideoGenerationRequest {
  /** 按能力快照档位就近映射后的请求时长（秒）。 */
  readonly durationSec: number;
  /** 已选首帧候选的字节（业务层从内容寻址存储读出，与图片参考图同通道）。 */
  readonly firstFrame: Readonly<{ readonly bytes: Uint8Array; readonly mimeType: string }>;
  readonly invocationId: string;
  readonly modelId: string;
  readonly prompt: string;
  readonly resolution: Readonly<{ readonly height: number; readonly width: number }>;
}

/**
 * 终态结果引用：下载段的唯一句柄（url 24h 有效、可持久化用于重启后恢复下载段）。
 * actualDurationSec 为 Provider 回报的实际时长，未回报则 null 如实——不得估算。
 */
export interface VideoResultRef extends ImageResultRef {
  readonly actualDurationSec: number | null;
}

/** submit() 双形态（结构同构图片域）：Seedance 恒 ASYNC（create task→poll→download）。 */
export type VideoTaskSubmission = ImageTaskSubmission;
/** poll() 任务状态判别联合（结构同构图片域）。 */
export type VideoTaskStatus = ImageTaskStatus;
/** download() 返回的 mp4 字节与 mimeType（结构同构图片域，宽高以结果引用为准）。 */
export type VideoDownload = ImageDownload;
/** Provider 上报用量（结构同构图片域：generated_images/output_tokens 语义沿用）。 */
export type VideoUsage = ImageGenerationUsage;
/** 成功响应原文（main-only 留证；结构同构图片域，超 64 KiB 截断如实标记）。 */
export type VideoRawResponse = ImageRawResponse;
/** 适配器错误证据通道（main-only；结构同构图片域）。 */
export type VideoModelEvidence = ModelCallEvidence;
