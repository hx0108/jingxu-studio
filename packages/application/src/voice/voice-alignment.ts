/**
 * TTS 配音时长与镜头时长的显式对齐引擎（v2-voice-audio-timeline design D4；
 * PRD v1.4 §10.7.1）。纯函数零 I/O 零时钟：分类与默认策略仅由版本化阈值
 * 决定，对齐记录随时间线版本冻结，规则版本随导出报告输出。
 */

/** 对齐规则版本；阈值调整必须递增并同步导出报告口径。 */
export const VOICE_ALIGNMENT_RULES_VERSION = 'jingxu-voice-alignment-rules/1';

/** 基本相等的绝对容差（毫秒）。 */
export const VOICE_ALIGNED_TOLERANCE_MS = 300;
/** 基本相等的相对容差（占镜头时长比例）。 */
export const VOICE_ALIGNED_TOLERANCE_RATIO = 0.05;
/** 音频远长于镜头的绝对阈值（毫秒）。 */
export const VOICE_FAR_LONG_ABS_MS = 2000;
/** 音频远长于镜头的相对阈值（占镜头时长比例）。 */
export const VOICE_FAR_LONG_RATIO = 0.5;

export type VoiceAlignmentCategory = 'ALIGNED' | 'SLIGHTLY_LONG' | 'FAR_LONG' | 'SHORTER';

export type VoiceAlignmentStrategy =
  | 'DIRECT_MIX'
  | 'FREEZE_EXTEND'
  | 'BLOCK_STORYBOARD_FALLBACK'
  | 'TAIL_SILENCE'
  | 'MANUAL_TRIM_AUDIO'
  | 'FORCE_TRIM_DIALOGUE_INCOMPLETE'
  | 'EARLY_CUT_NEXT';

/** 人工覆盖（PRD §10.7.1 人工可覆盖列）；按类别限制合法组合。 */
export type VoiceAlignmentManualOverride = 'TRIM_AUDIO' | 'FORCE_TRIM' | 'EARLY_CUT_NEXT';

export interface VoiceAlignmentInput {
  readonly audioDurationMs: number;
  readonly manualOverride: VoiceAlignmentManualOverride | null;
  readonly shotDurationMs: number;
}

export interface VoiceAlignmentResult {
  readonly audioDurationMs: number;
  readonly category: VoiceAlignmentCategory;
  /** 对白是否完整：任何裁剪音频的处置都不得默认为完整。 */
  readonly dialogueComplete: boolean;
  /** 静帧延展毫秒数；仅 FREEZE_EXTEND 为正，其余为 0。 */
  readonly extendedMs: number;
  readonly manualOverride: VoiceAlignmentManualOverride | null;
  readonly rulesVersion: string;
  readonly shotDurationMs: number;
  readonly storyboardFallback: boolean;
  readonly strategy: VoiceAlignmentStrategy;
}

const isValidDuration = (value: number): boolean =>
  Number.isInteger(value) && value > 0 && value <= 3_600_000;

/**
 * 对单镜头执行对齐分类与策略选择。
 * @throws 时长非正整数，或人工覆盖与偏差类别不构成 PRD §10.7.1 合法组合
 * （覆盖不得静默改变类别语义，错配必须显式失败由调用方归一化）。
 */
export const alignVoiceToShot = (input: VoiceAlignmentInput): VoiceAlignmentResult => {
  const { audioDurationMs, manualOverride, shotDurationMs } = input;
  if (!isValidDuration(audioDurationMs) || !isValidDuration(shotDurationMs)) {
    throw new Error(
      'VOICE_ALIGNMENT_INPUT_INVALID: audioDurationMs/shotDurationMs 必须为正整数毫秒。',
    );
  }
  const diff = audioDurationMs - shotDurationMs;
  const alignedTolerance = Math.max(
    VOICE_ALIGNED_TOLERANCE_MS,
    shotDurationMs * VOICE_ALIGNED_TOLERANCE_RATIO,
  );
  const farLongThreshold = Math.max(VOICE_FAR_LONG_ABS_MS, shotDurationMs * VOICE_FAR_LONG_RATIO);

  const base: Omit<
    VoiceAlignmentResult,
    'category' | 'dialogueComplete' | 'extendedMs' | 'storyboardFallback' | 'strategy'
  > = {
    audioDurationMs,
    manualOverride,
    rulesVersion: VOICE_ALIGNMENT_RULES_VERSION,
    shotDurationMs,
  };

  if (Math.abs(diff) <= alignedTolerance) {
    if (manualOverride !== null) {
      throw new Error('VOICE_ALIGNMENT_OVERRIDE_INVALID: 基本相等类别无人工覆盖路径。');
    }
    return {
      ...base,
      category: 'ALIGNED',
      dialogueComplete: true,
      extendedMs: 0,
      storyboardFallback: false,
      strategy: 'DIRECT_MIX',
    };
  }
  if (diff < 0) {
    // 音频短于镜头：默认尾部静音；人工可提前切入下一镜头。
    if (manualOverride !== null && manualOverride !== 'EARLY_CUT_NEXT') {
      throw new Error('VOICE_ALIGNMENT_OVERRIDE_INVALID: 音频短于镜头仅允许 EARLY_CUT_NEXT 覆盖。');
    }
    return {
      ...base,
      category: 'SHORTER',
      dialogueComplete: true,
      extendedMs: 0,
      storyboardFallback: false,
      strategy: manualOverride === 'EARLY_CUT_NEXT' ? 'EARLY_CUT_NEXT' : 'TAIL_SILENCE',
    };
  }
  if (diff > farLongThreshold) {
    // 音频远长于镜头：默认阻断指引回分镜层；人工可强制裁剪并标记对白不完整。
    if (manualOverride !== null && manualOverride !== 'FORCE_TRIM') {
      throw new Error('VOICE_ALIGNMENT_OVERRIDE_INVALID: 音频远长于镜头仅允许 FORCE_TRIM 覆盖。');
    }
    return {
      ...base,
      category: 'FAR_LONG',
      // 阻断路径未裁剪音频，对白仍完整；仅强制裁剪才标记不完整。
      dialogueComplete: manualOverride !== 'FORCE_TRIM',
      extendedMs: 0,
      storyboardFallback: manualOverride !== 'FORCE_TRIM',
      strategy:
        manualOverride === 'FORCE_TRIM'
          ? 'FORCE_TRIM_DIALOGUE_INCOMPLETE'
          : 'BLOCK_STORYBOARD_FALLBACK',
    };
  }
  // 音频略长于镜头：默认静帧延展；人工可裁剪音频尾部（对白不完整风险自担）。
  if (manualOverride !== null && manualOverride !== 'TRIM_AUDIO') {
    throw new Error('VOICE_ALIGNMENT_OVERRIDE_INVALID: 音频略长于镜头仅允许 TRIM_AUDIO 覆盖。');
  }
  return {
    ...base,
    category: 'SLIGHTLY_LONG',
    dialogueComplete: manualOverride !== 'TRIM_AUDIO',
    extendedMs: manualOverride === 'TRIM_AUDIO' ? 0 : diff,
    storyboardFallback: false,
    strategy: manualOverride === 'TRIM_AUDIO' ? 'MANUAL_TRIM_AUDIO' : 'FREEZE_EXTEND',
  };
};
