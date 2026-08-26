import type { ModelErrorCode } from '../text-model/text-model-types';

/**
 * 语音（TTS）模型 Port 类型（v2-voice-audio-timeline design D2）。
 *
 * Ark TTS 为同步 HTTP 返回音频字节——单段 synthesize 即终态，不引入
 * submit/poll/download 三段式；无结果 URL，字节直接进内容寻址存储。
 * 证据通道沿用 media-invocation-evidence 的 ModelCallEvidence（成功段
 * body 为音频字节，不落 bodyText）。
 */

/** 单次合成请求（业务层组装；Adapter 映射到具体 Provider 接口与参数白名单）。 */
export interface TtsSynthesisRequest {
  readonly invocationId: string;
  readonly modelId: string;
  /** 待合成台词原文（= shot contract 的 spoken_text）；长度边界由 Adapter 按注册表快照断言。 */
  readonly spokenText: string;
  /** 目标音色（来自 project 级 speaker→voice 映射；narrator 为旁白固定行）。 */
  readonly voiceId: string;
}

/** 合成音频载荷；mimeType 必须命中注册表快照的输出 mime 白名单。 */
export interface TtsAudioPayload {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

/** Provider 上报用量；未知字段为 null（快照形状由 2.2 Schema Probe 回写）。 */
export interface TtsGenerationUsage {
  readonly outputCharacters: number | null;
  readonly outputTokens: number | null;
}

/**
 * 单次合成成功结果。
 *
 * 刻意不携带 durationMs：Provider 自报时长不受信，音频时长一律由落库段
 * ffprobe 实测（4.3）后作为对齐引擎输入——这是可审计对齐记录的前提。
 */
export interface TtsSynthesisResult {
  readonly audio: TtsAudioPayload;
  /** 成功响应 HTTP 状态码（证据行记录用；失败原文经 evidenceOf 通道提取）。 */
  readonly httpStatus: number;
  readonly providerRequestId: string | null;
  readonly usage: TtsGenerationUsage | null;
}

/** 适配器错误的稳定归一化码集合（复用 ModelErrorCode 联合，见 text-model-types）。 */
export type TtsErrorCode = ModelErrorCode;
