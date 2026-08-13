import { describe, expect, it } from 'vitest';

import { countCodePoints, normalizeNameKey, validateProjectName } from './project-name';

describe('Project 名称领域规则', () => {
  describe('validateProjectName—code point 计数', () => {
    it('空字符串—拒绝为 EMPTY', () => {
      expect(validateProjectName('')).toStrictEqual({ kind: 'EMPTY' });
    });

    it('单个字符—通过', () => {
      expect(validateProjectName('A')).toBeNull();
    });

    it('刚好 100 个字符—通过', () => {
      expect(validateProjectName('啊'.repeat(100))).toBeNull();
    });

    it('101 个字符—拒绝为 TOO_LONG 并返回实际码点数', () => {
      expect(validateProjectName('啊'.repeat(101))).toStrictEqual({
        kind: 'TOO_LONG',
        codePoints: 101,
      });
    });
  });

  describe('validateProjectName—首尾空白（不静默 trim）', () => {
    it('前导普通空格—拒绝为 LEADING_OR_TRAILING_WHITESPACE', () => {
      expect(validateProjectName(' 合法名称')).toStrictEqual({
        kind: 'LEADING_OR_TRAILING_WHITESPACE',
      });
    });

    it('尾部全角空格 U+3000—拒绝', () => {
      expect(validateProjectName('合法名称　')).toStrictEqual({
        kind: 'LEADING_OR_TRAILING_WHITESPACE',
      });
    });

    it('纯空白串—拒绝为有首尾空白而非静默接受', () => {
      expect(validateProjectName('   ')).toStrictEqual({
        kind: 'LEADING_OR_TRAILING_WHITESPACE',
      });
    });
  });

  describe('countCodePoints', () => {
    it('BMP 之外字符—代理对按一个 code point 计数', () => {
      // U+1F600 在 UTF-16 中占两个单元，但只是一个 code point。
      expect(countCodePoints('😀')).toBe(1);
    });
  });

  describe('normalizeNameKey—冲突键归一', () => {
    it('NFC 等价—预组合与分解字符归一为同一键', () => {
      // 用纯 ASCII 转义确保两字面量字节确实不同：
      //   composed   = "caf" + U+00E9（预组合，单一码点）
      //   decomposed = "cafe" + U+0301（分解，两码点）
      const composed = 'caf\u{00e9}';
      const decomposed = 'cafe\u{0301}';
      expect(composed).not.toBe(decomposed);
      expect(normalizeNameKey(composed)).toBe(normalizeNameKey(decomposed));
    });

    it('zh-CN 大小写—大小写差异归一为同一键', () => {
      expect(normalizeNameKey('Project Alpha')).toBe(normalizeNameKey('PROJECT ALPHA'));
    });
  });
});
