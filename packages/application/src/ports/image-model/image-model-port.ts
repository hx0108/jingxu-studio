import type { CredentialCheck, NormalizedModelError } from '../text-model/text-model-types';
import type {
  ImageDownload,
  ImageGenerationRequest,
  ImageResultRef,
  ImageTaskStatus,
  ImageTaskSubmission,
} from './image-model-types';

/**
 * 图片模型 Application Port（shot-first-frame-image-generation design D2）。
 *
 * Application 只依赖该接口与归一化类型；方舟响应结构、HTTP header、
 * Authorization 或 Provider 专有错误只允许存在于实现该 Port 的 Adapter
 * （SeedreamImageModelAdapter / MockImageModelAdapter）。状态机
 * （提交→轮询→下载→落盘→落库）由确定性调度代码驱动，Adapter 只做单段 HTTP
 * 与归一化——重试、状态码路由属于确定性代码，不属模型。
 */
export interface ImageModelPort {
  /** 校验凭据可用性；不把明文 Key 暴露给业务层。 */
  validateCredential(): Promise<CredentialCheck>;
  /**
   * 提交一次单图生成（方舟无 n 参数，N 候选 = N 次 submit）。
   * 同步 Provider 直接返回终态结果引用；异步 Provider 返回 providerTaskId，
   * 调用方必须先持久化再进入轮询（重启恢复依据）。signal 取消 SHALL 归一化
   * MODEL_CANCELLED。
   */
  submit(request: ImageGenerationRequest, signal: AbortSignal): Promise<ImageTaskSubmission>;
  /** 轮询异步任务；同步形态下恒即时 SUCCEEDED。 */
  poll(providerTaskId: string, signal: AbortSignal): Promise<ImageTaskStatus>;
  /**
   * 经结果 URL 下载字节。URL 失效或不可得 SHALL 归一化为
   * MODEL_RESULT_UNAVAILABLE（不可重试下载，需重新生成）。
   */
  download(resultRef: ImageResultRef, signal: AbortSignal): Promise<ImageDownload>;
  /** 将 Provider 专有错误归一化为稳定 NormalizedModelError，脱敏后返回。 */
  normalizeError(error: unknown): NormalizedModelError;
}
