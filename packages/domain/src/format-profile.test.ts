import { describe, expect, it } from 'vitest';

import {
  ASPECT_RATIOS,
  createFormatProfileSpec,
  DEFAULT_SUBTITLE_SAFE_AREA,
  deriveDimensions,
  FIXED_FPS,
  formatProfileSpecsEqual,
  SUPPORTED_LANGUAGE,
  validateSubtitleSafeArea,
} from './format-profile';

describe('V1 FormatProfile 领域规格', () => {
  describe('deriveDimensions—画幅 preset', () => {
    it('9:16—派生为 1080x1920', () => {
      expect(deriveDimensions('9:16')).toStrictEqual({ width: 1080, height: 1920 });
    });

    it('16:9—派生为 1920x1080', () => {
      expect(deriveDimensions('16:9')).toStrictEqual({ width: 1920, height: 1080 });
    });
  });

  describe('createFormatProfileSpec—构造与防伪造', () => {
    it('默认安全区—9:16—固定 5/5/12/5、30fps、zh-CN、1080x1920', () => {
      expect(createFormatProfileSpec('9:16', DEFAULT_SUBTITLE_SAFE_AREA)).toStrictEqual({
        aspectRatio: '9:16',
        width: 1080,
        height: 1920,
        fps: FIXED_FPS,
        language: SUPPORTED_LANGUAGE,
        subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
      });
    });

    it('画幅伪造—运行时枚举只含 9:16/16:9，排除 1:1', () => {
      expect(ASPECT_RATIOS).toStrictEqual(['9:16', '16:9']);
    });

    it('机器字段伪造—fps/language/尺寸由 preset 决定，不接受外部覆盖', () => {
      const spec = createFormatProfileSpec('16:9', { top: 0, right: 0, bottom: 0, left: 0 });
      expect(spec.fps).toBe(30);
      expect(spec.language).toBe('zh-CN');
      expect(spec.width).toBe(1920);
      expect(spec.height).toBe(1080);
    });
  });

  describe('validateSubtitleSafeArea—安全区边界', () => {
    it('边界值—四个边均为 0—通过', () => {
      expect(validateSubtitleSafeArea({ top: 0, right: 0, bottom: 0, left: 0 })).toBeNull();
    });

    it('边界值—四个边均为 30—通过', () => {
      expect(validateSubtitleSafeArea({ top: 30, right: 30, bottom: 30, left: 30 })).toBeNull();
    });

    it('越界—top 为 31—拒绝为 OUT_OF_RANGE', () => {
      expect(validateSubtitleSafeArea({ top: 31, right: 5, bottom: 12, left: 5 })).toStrictEqual({
        field: 'top',
        kind: 'OUT_OF_RANGE',
        value: 31,
      });
    });

    it('越界—right 为负—拒绝为 OUT_OF_RANGE', () => {
      expect(validateSubtitleSafeArea({ top: 5, right: -1, bottom: 12, left: 5 })).toStrictEqual({
        field: 'right',
        kind: 'OUT_OF_RANGE',
        value: -1,
      });
    });

    it('非有限—top 为 NaN—拒绝为 NOT_FINITE', () => {
      expect(
        validateSubtitleSafeArea({ top: Number.NaN, right: 5, bottom: 12, left: 5 }),
      ).toStrictEqual({ field: 'top', kind: 'NOT_FINITE', value: Number.NaN });
    });

    it('非有限—bottom 为 Infinity—拒绝为 NOT_FINITE', () => {
      expect(
        validateSubtitleSafeArea({ top: 5, right: 5, bottom: Number.POSITIVE_INFINITY, left: 5 }),
      ).toStrictEqual({
        field: 'bottom',
        kind: 'NOT_FINITE',
        value: Number.POSITIVE_INFINITY,
      });
    });
  });

  describe('formatProfileSpecsEqual—语义相等', () => {
    it('相同规格—true', () => {
      const a = createFormatProfileSpec('9:16', DEFAULT_SUBTITLE_SAFE_AREA);
      const b = createFormatProfileSpec('9:16', { ...DEFAULT_SUBTITLE_SAFE_AREA });
      expect(formatProfileSpecsEqual(a, b)).toBe(true);
    });

    it('画幅不同—false', () => {
      const a = createFormatProfileSpec('9:16', DEFAULT_SUBTITLE_SAFE_AREA);
      const b = createFormatProfileSpec('16:9', DEFAULT_SUBTITLE_SAFE_AREA);
      expect(formatProfileSpecsEqual(a, b)).toBe(false);
    });

    it('仅安全区 bottom 不同—false', () => {
      const a = createFormatProfileSpec('9:16', DEFAULT_SUBTITLE_SAFE_AREA);
      const b = createFormatProfileSpec('9:16', { ...DEFAULT_SUBTITLE_SAFE_AREA, bottom: 15 });
      expect(formatProfileSpecsEqual(a, b)).toBe(false);
    });
  });
});
