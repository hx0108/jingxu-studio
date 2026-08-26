/**
 * DashScope Qwen3-TTS 模型与音色受限注册表（v2-voice-audio-timeline design D1 修订）。
 *
 * 2026-08-26 D1 修订：Ark TTS 前提被免费探测证伪（/api/v3/audio/speech 路由
 * 不存在 + 模型目录无 TTS 条目），Provider 改道 DashScope qwen3-tts（原生
 * multimodal-generation 路由）。全部条目已由 2.2 Schema Probe 受限预算实测
 * 核验（2026-08-27）：
 *
 * - 模型 qwen3-tts-instruct-flash：真实合成一次验证响应形状（OSS url 交付
 *   24kHz 单声道 16bit WAV）+ 音色校验差分针；官方稳定版快照 2026-01-26。
 * - 音色：官方音色表（2026-06-25 快照）"支持模型"列真实预测非实时逐模型
 *   支持度（7 数据点零偏差），四音色均以差分针在该模型上实测通过
 *   （穿过音色校验、命中 [0,600] 文本上限错）；Dylan/Lenn 表列仅 realtime
 *   系→实测被拒，故未收录。
 * - 文本长度上限 [0,600] 字符（实测）；语速控制仅经 instructions 自然语言，
 *   无数值参数——Phase1 对比合成（同文本+"语速极快"）实测 1.27x（4 字短
 *   样本，首尾静音占比大），maxSpeechRate 保守取 1.25。
 */

export type TtsProbeStatus = 'PENDING' | 'VERIFIED';

export interface TtsModelDefinition {
  readonly id: string;
  readonly label: string;
  /** 语速上限（对齐策略「按语速上限重生成 TTS」的重生成档位）；qwen3-tts 仅经 instructions 控制，Phase1 实测 1.27x 保守取 1.25。 */
  readonly maxSpeechRate: number;
  /** Provider 实际可返回的音频容器（2.2 实测：OSS 交付 audio/x-wav）。 */
  readonly outputMimeTypes: readonly ('audio/mpeg' | 'audio/wav' | 'audio/mp4')[];
  readonly probeStatus: TtsProbeStatus;
  readonly selectable: boolean;
  /** 官方快照日期；未探测时固定 'pending-probe'，核验后回写。 */
  readonly snapshotDate: string;
}

export interface TtsVoiceDefinition {
  readonly id: string;
  readonly label: string;
  readonly gender: 'FEMALE' | 'MALE' | 'NEUTRAL';
  readonly probeStatus: TtsProbeStatus;
  readonly selectable: boolean;
  readonly snapshotDate: string;
}

export const QWEN_TTS_MODELS = [
  {
    id: 'qwen3-tts-instruct-flash',
    label: '千问3-TTS-Instruct-Flash',
    maxSpeechRate: 1.25,
    outputMimeTypes: ['audio/wav'] as const,
    probeStatus: 'VERIFIED',
    selectable: true,
    snapshotDate: '2026-01-26',
  },
] as const satisfies readonly TtsModelDefinition[];

export type QwenTtsModelId = (typeof QWEN_TTS_MODELS)[number]['id'];

export const DEFAULT_QWEN_TTS_MODEL_ID: QwenTtsModelId = 'qwen3-tts-instruct-flash';

/**
 * 音色注册表：id 取自官方 Qwen-TTS 系统音色表（2026-06-25 快照），逐模型
 * 支持度经差分针实测（见文件头）。narrator 固定映射 NARRATOR_DEFAULT_VOICE_ID。
 */
export const QWEN_TTS_VOICES = [
  {
    id: 'Neil',
    label: '旁白男声·阿闻（专业新闻主持）',
    gender: 'MALE',
    probeStatus: 'VERIFIED',
    selectable: true,
    snapshotDate: '2026-06-25',
  },
  {
    id: 'Elias',
    label: '旁白女声·墨讲师（知性叙事）',
    gender: 'FEMALE',
    probeStatus: 'VERIFIED',
    selectable: true,
    snapshotDate: '2026-06-25',
  },
  {
    id: 'Mochi',
    label: '少年男声·沙小弥（小大人）',
    gender: 'MALE',
    probeStatus: 'VERIFIED',
    selectable: true,
    snapshotDate: '2026-06-25',
  },
  {
    id: 'Stella',
    label: '少年女声·阿月（元气少女）',
    gender: 'FEMALE',
    probeStatus: 'VERIFIED',
    selectable: true,
    snapshotDate: '2026-06-25',
  },
] as const satisfies readonly TtsVoiceDefinition[];

export type QwenTtsVoiceId = (typeof QWEN_TTS_VOICES)[number]['id'];

/** NARRATION_FIRST 的 narrator 固定旁白音色（spec voice-audio-timeline R3）。 */
export const NARRATOR_DEFAULT_VOICE_ID: QwenTtsVoiceId = 'Neil';

export const isQwenTtsModelId = (value: string): value is QwenTtsModelId =>
  QWEN_TTS_MODELS.some((model) => model.id === value);

export const getQwenTtsModel = (value: string): TtsModelDefinition | null =>
  QWEN_TTS_MODELS.find((model) => model.id === value) ?? null;

export const isQwenTtsVoiceId = (value: string): value is QwenTtsVoiceId =>
  QWEN_TTS_VOICES.some((voice) => voice.id === value);

export const getQwenTtsVoice = (value: string): TtsVoiceDefinition | null =>
  QWEN_TTS_VOICES.find((voice) => voice.id === value) ?? null;

// SELECTABLE_* 过滤导出暂不加回：2.2 探测后全部条目 selectable:true，过滤恒真
// 且触发 no-unnecessary-condition（与 seedance 混合 selectable 语义不同）；
// 未来出现 PENDING/不可选条目（如旧快照下线）时再恢复。
