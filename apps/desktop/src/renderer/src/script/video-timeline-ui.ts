/**
 * 配音/字幕时间线 UI 的共享文案映射（v2 §7）。
 * 标签与稳定码解耦：未知原码如实展示，不猜测语义。
 */

/** 对齐偏差类别的中文标签（v2 design D4）。 */
export const ALIGNMENT_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  ALIGNED: '基本相等',
  FAR_LONG: '远长于镜头',
  SHORTER: '短于镜头',
  SLIGHTLY_LONG: '略长于镜头',
};

/** 对齐策略的中文标签；策略名随版本冻结，直接稳定展示。 */
export const ALIGNMENT_STRATEGY_LABELS: Readonly<Record<string, string>> = {
  BLOCK_STORYBOARD_FALLBACK: '分镜层回退（阻断导出）',
  DIRECT_MIX: '直接混音',
  EARLY_CUT_NEXT: '提前切到下一镜',
  FORCE_TRIM_DIALOGUE_INCOMPLETE: '强制裁剪（对白不完整）',
  FREEZE_EXTEND: '末帧延展',
  MANUAL_TRIM_AUDIO: '人工截短配音',
  TAIL_SILENCE: '片尾静音补位',
};

/** 人工覆盖选项：空值=默认策略（由冻结规则按类别决定）。 */
export const OVERRIDE_OPTIONS: readonly { readonly label: string; readonly value: string }[] = [
  { label: '默认策略', value: '' },
  { label: '截短配音（对白完整）', value: 'TRIM_AUDIO' },
  { label: '强制裁剪（对白不完整）', value: 'FORCE_TRIM' },
  { label: '提前切到下一镜', value: 'EARLY_CUT_NEXT' },
];

/** 整集批量跳过原因的中文回告。 */
export const SKIP_REASON_LABELS: Readonly<Record<string, string>> = {
  ALREADY_GENERATED: '已有成功候选',
  NOT_VOICE_TARGET: '该镜头无台词或未要求配音',
};

/** speakerId 的展示标签：narrator 固定为旁白，角色 ID 截前缀原样展示。 */
export const speakerLabel = (speakerId: string): string =>
  speakerId === 'narrator' ? '旁白' : speakerId.replace(/^char_/u, '');
