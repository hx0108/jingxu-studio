/**
 * 火山方舟 TTS 模型与音色受限注册表（v2-voice-audio-timeline design D1）。
 *
 * 全部条目初始 probeStatus='PENDING'：id 与能力字段为立项占位值，仅当
 * tasks 2.2 Schema Probe 以受限预算实测核验（请求/响应形状、输出格式、
 * 音色事实）后才回写为 'VERIFIED' 并允许 selectable=true。探测未通过的
 * 条目 MUST NOT 进入真实生成（spec voice-audio-timeline R1）。
 */

export type TtsProbeStatus = 'PENDING' | 'VERIFIED';

export interface TtsModelDefinition {
  readonly id: string;
  readonly label: string;
  /** 语速上限（对齐策略「按语速上限重生成 TTS」的重生成档位）。 */
  readonly maxSpeechRate: number;
  /** Provider 实际可返回的音频容器；探测核验前为占位全集。 */
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

export const ARK_TTS_MODELS = [
  {
    id: 'doubao-seed-tts-1-0-pending-probe',
    label: '豆包语音合成（待探测核验）',
    maxSpeechRate: 2.0,
    outputMimeTypes: ['audio/mpeg', 'audio/wav', 'audio/mp4'] as const,
    probeStatus: 'PENDING',
    selectable: false,
    snapshotDate: 'pending-probe',
  },
] as const satisfies readonly TtsModelDefinition[];

export type ArkTtsModelId = (typeof ARK_TTS_MODELS)[number]['id'];

export const DEFAULT_ARK_TTS_MODEL_ID: ArkTtsModelId = 'doubao-seed-tts-1-0-pending-probe';

/**
 * 音色注册表：id 为探测前占位（编号音色），Schema Probe 后以火山方舟
 * 官方 voice_type id 回写替换。narrator 固定映射 NARRATOR_DEFAULT_VOICE_ID。
 */
export const ARK_TTS_VOICES = [
  {
    id: 'ark-tts-voice-pending-01',
    label: '旁白男声（待探测核验）',
    gender: 'MALE',
    probeStatus: 'PENDING',
    selectable: false,
    snapshotDate: 'pending-probe',
  },
  {
    id: 'ark-tts-voice-pending-02',
    label: '旁白女声（待探测核验）',
    gender: 'FEMALE',
    probeStatus: 'PENDING',
    selectable: false,
    snapshotDate: 'pending-probe',
  },
  {
    id: 'ark-tts-voice-pending-03',
    label: '少年男声（待探测核验）',
    gender: 'MALE',
    probeStatus: 'PENDING',
    selectable: false,
    snapshotDate: 'pending-probe',
  },
  {
    id: 'ark-tts-voice-pending-04',
    label: '少年女声（待探测核验）',
    gender: 'FEMALE',
    probeStatus: 'PENDING',
    selectable: false,
    snapshotDate: 'pending-probe',
  },
] as const satisfies readonly TtsVoiceDefinition[];

export type ArkTtsVoiceId = (typeof ARK_TTS_VOICES)[number]['id'];

/** NARRATION_FIRST 的 narrator 固定旁白音色（spec voice-audio-timeline R3）。 */
export const NARRATOR_DEFAULT_VOICE_ID: ArkTtsVoiceId = 'ark-tts-voice-pending-01';

export const isArkTtsModelId = (value: string): value is ArkTtsModelId =>
  ARK_TTS_MODELS.some((model) => model.id === value);

export const getArkTtsModel = (value: string): TtsModelDefinition | null =>
  ARK_TTS_MODELS.find((model) => model.id === value) ?? null;

export const isArkTtsVoiceId = (value: string): value is ArkTtsVoiceId =>
  ARK_TTS_VOICES.some((voice) => voice.id === value);

export const getArkTtsVoice = (value: string): TtsVoiceDefinition | null =>
  ARK_TTS_VOICES.find((voice) => voice.id === value) ?? null;

// SELECTABLE_* 过滤导出待 tasks 2.2 Schema Probe 将条目翻转为 selectable:true
// 后再加回：当前全部条目恒 false，过滤恒空且触发 no-unnecessary-condition。
