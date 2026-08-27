import type { ModelCallEvidence } from '../image-model/image-model-types';
import type { CredentialCheck, NormalizedModelError } from '../text-model/text-model-types';
import type { TtsSynthesisRequest, TtsSynthesisResult } from './tts-model-types';

/**
 * 语音模型 Application Port（v2-voice-audio-timeline design D2）。
 *
 * Application 只依赖该接口与归一化类型；Provider 请求形状、HTTP header、
 * Authorization 或 Provider 专有错误只允许存在于实现该 Port 的 Adapter
 * （QwenTtsModelAdapter / MockTtsModelAdapter）。同项目严格串行、两段式证据、
 * 取消先落库由确定性调度代码（VoiceGenerationScheduler，4.2）驱动，Adapter
 * 只做单段同步 HTTP 与归一化——重试与状态码路由属于确定性代码，不属模型。
 */
export interface TtsModelPort {
  /** 校验凭据可用性；不把明文 Key 暴露给业务层（零计费，仅解密加载）。 */
  validateCredential(): Promise<CredentialCheck>;
  /**
   * 同步合成一次配音：调用返回即终态，音频字节随结果返回（Provider 内部的
   * OSS 中转 URL 由适配器完成下载、不出适配器边界；业务层无 download 段）。
   * signal 取消 SHALL 归一化为 MODEL_CANCELLED。
   * 结果不含 durationMs——时长由落库段 ffprobe 实测（4.3），Provider 自报不受信。
   */
  synthesize(request: TtsSynthesisRequest, signal: AbortSignal): Promise<TtsSynthesisResult>;
  /** 将 Provider 专有错误归一化为稳定 NormalizedModelError，脱敏后返回。 */
  normalizeError(error: unknown): NormalizedModelError;
  /**
   * 主进程证据通道（media-invocation-evidence design D5）：从适配器错误中
   * 提取原始响应（httpStatus/bodyText）供 media_model_invocations 留档；非本
   * 适配器错误返回 null。MUST NOT 进入 NormalizedModelError、日志或 Renderer。
   */
  evidenceOf(error: unknown): ModelCallEvidence | null;
}
