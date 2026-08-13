/**
 * Project 名称领域规则。
 *
 * 冲突判定基于确定性规范化键（NFC + zh-CN 小写），由 Application 在
 * 单一写连接、`BEGIN IMMEDIATE` 事务内检查。不依赖数据库 `lower()`，
 * 因为 SQLite 内建 lower 无法可靠复现 Unicode/JS NFC 规则。
 */

export const PROJECT_NAME_MIN_CODE_POINTS = 1;
export const PROJECT_NAME_MAX_CODE_POINTS = 100;

export type ProjectNameValidationError =
  | { readonly kind: 'EMPTY' }
  | { readonly kind: 'LEADING_OR_TRAILING_WHITESPACE' }
  | { readonly kind: 'TOO_LONG'; readonly codePoints: number };

/** 按 Unicode code point 计数，正确处理 BMP 之外的代理对。 */
export const countCodePoints = (value: string): number => Array.from(value).length;

/**
 * 判断是否存在首尾 Unicode 空白。
 *
 * 调用方必须传入已去除首尾空白的文本，本函数拒绝而不静默 trim，
 * 避免用户误以为提交的空白被接受。String.prototype.trim 覆盖 Unicode
 * 空白（含全角空格 U+3000）与行终止符。
 */
const hasLeadingOrTrailingWhitespace = (value: string): boolean => value !== value.trim();

/** 校验 Project 名称原始输入，返回首个违反的规则或 null。 */
export const validateProjectName = (input: string): ProjectNameValidationError | null => {
  if (countCodePoints(input) < PROJECT_NAME_MIN_CODE_POINTS) {
    return { kind: 'EMPTY' };
  }
  if (hasLeadingOrTrailingWhitespace(input)) {
    return { kind: 'LEADING_OR_TRAILING_WHITESPACE' };
  }
  const codePoints = countCodePoints(input);
  if (codePoints > PROJECT_NAME_MAX_CODE_POINTS) {
    return { kind: 'TOO_LONG', codePoints };
  }
  return null;
};

/**
 * 生成确定性冲突键：NFC 规范化后按 zh-CN locale 小写。
 *
 * 用于活动项目名称唯一性比对。NFC 等价的预组合/分解字符、以及 zh-CN
 * 大小写差异，都归一为同一键。
 */
export const normalizeNameKey = (input: string): string =>
  input.normalize('NFC').toLocaleLowerCase('zh-CN');
