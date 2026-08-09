/**
 * V1 FormatProfile 领域规格。
 *
 * 用户只控制画幅与字幕安全区；像素尺寸由画幅 preset 派生，帧率与语言固定。
 * 构造入口不接受 width/height/fps/language，从源头杜绝伪造机器字段。
 * V1 只接受 9:16 与 16:9，拒绝数据库较宽 CHECK 允许的 1:1。
 */

export const ASPECT_RATIOS = ['9:16', '16:9'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** V1 固定帧率，不接受调用方覆盖。 */
export const FIXED_FPS = 30;
/** V1 固定语言，不接受调用方覆盖。 */
export const SUPPORTED_LANGUAGE = 'zh-CN';

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

export interface SubtitleSafeArea {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** 来自正式示例的默认字幕安全区：top/right/left 5%，bottom 12%。 */
export const DEFAULT_SUBTITLE_SAFE_AREA: SubtitleSafeArea = {
  top: 5,
  right: 5,
  bottom: 12,
  left: 5,
};

export const SUBTITLE_SAFE_AREA_MIN = 0;
export const SUBTITLE_SAFE_AREA_MAX = 30;

export type SubtitleSafeAreaField = 'top' | 'right' | 'bottom' | 'left';

export type SubtitleSafeAreaError = {
  readonly field: SubtitleSafeAreaField;
  readonly kind: 'OUT_OF_RANGE' | 'NOT_FINITE';
  readonly value: number;
};

const SUBTITLE_SAFE_AREA_FIELDS = ['top', 'right', 'bottom', 'left'] as const;

/** 校验字幕安全区四个百分比，每个必须为 0–30 的有限数。 */
export const validateSubtitleSafeArea = (area: SubtitleSafeArea): SubtitleSafeAreaError | null => {
  for (const field of SUBTITLE_SAFE_AREA_FIELDS) {
    const value = area[field];
    if (!Number.isFinite(value)) {
      return { field, kind: 'NOT_FINITE', value };
    }
    if (value < SUBTITLE_SAFE_AREA_MIN || value > SUBTITLE_SAFE_AREA_MAX) {
      return { field, kind: 'OUT_OF_RANGE', value };
    }
  }
  return null;
};

const DIMENSIONS_BY_ASPECT_RATIO: Readonly<Record<AspectRatio, Dimensions>> = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
};

/** 由画幅派生像素尺寸，调用方不传入 width/height。 */
export const deriveDimensions = (aspectRatio: AspectRatio): Dimensions =>
  DIMENSIONS_BY_ASPECT_RATIO[aspectRatio];

export interface FormatProfileSpec {
  readonly aspectRatio: AspectRatio;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly language: string;
  readonly subtitleSafeArea: SubtitleSafeArea;
}

/**
 * 构造 V1 FormatProfile 规格。
 *
 * 仅接受画幅与字幕安全区；像素尺寸由 preset 派生，fps/language 固定，
 * 调用方无法注入 width/height/fps/language/target_platform 等机器字段。
 */
export const createFormatProfileSpec = (
  aspectRatio: AspectRatio,
  subtitleSafeArea: SubtitleSafeArea,
): FormatProfileSpec => {
  const { width, height } = deriveDimensions(aspectRatio);
  return {
    aspectRatio,
    width,
    height,
    fps: FIXED_FPS,
    language: SUPPORTED_LANGUAGE,
    subtitleSafeArea,
  };
};

/**
 * 语义相等比较。
 *
 * 逐字段比对画幅、派生尺寸、帧率、语言与四边安全区，不依赖对象属性顺序或
 * 序列化格式，避免 UI 格式化或 JSON 属性顺序制造空版本。
 */
export const formatProfileSpecsEqual = (a: FormatProfileSpec, b: FormatProfileSpec): boolean =>
  a.aspectRatio === b.aspectRatio &&
  a.width === b.width &&
  a.height === b.height &&
  a.fps === b.fps &&
  a.language === b.language &&
  a.subtitleSafeArea.top === b.subtitleSafeArea.top &&
  a.subtitleSafeArea.right === b.subtitleSafeArea.right &&
  a.subtitleSafeArea.bottom === b.subtitleSafeArea.bottom &&
  a.subtitleSafeArea.left === b.subtitleSafeArea.left;
