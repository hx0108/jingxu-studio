/**
 * ShotContract 锁定路径策略（PRD 9.8.1 / TECH_DESIGN §9.2，shot-edit-lock design 定案）。
 *
 * 纯函数集：RFC 6901 JSON Pointer 解析（仅 ~0/~1 转义、空 token 拒绝）、
 * 七个一级根白名单、数组下标 token 禁止、路径在当前文档可解析、
 * 锁/写 token 前缀冲突判定（父/子/相等均冲突）、编辑器场景写集推导
 * （七根 + target_duration_sec 的根级变更集）。不接触仓储与事务。
 */

/** 可锁定的七个一级根（PRD 9.8.1；ID/版本/状态/provenance 与数组下标不可锁）。 */
export const LOCKABLE_ROOTS = [
  'narrative_purpose',
  'cinematography',
  'content',
  'dialogue',
  'continuity',
  'generation_constraints',
  'acceptance',
] as const;

/** 人工编辑允许变更的根（锁定白名单七根 + target_duration_sec，后者不可锁）。 */
export const EDITABLE_ROOTS = [...LOCKABLE_ROOTS, 'target_duration_sec'] as const;

export type LockPointerErrorCode =
  | 'LOCK_POINTER_MALFORMED'
  | 'LOCK_ROOT_NOT_LOCKABLE'
  | 'LOCK_ARRAY_INDEX_FORBIDDEN'
  | 'LOCK_PATH_UNRESOLVED';

export type LockPointerCheck =
  | Readonly<{ ok: true; tokens: readonly string[] }>
  | Readonly<{ code: LockPointerErrorCode; detail: string; ok: false }>;

/** RFC 6901 token 转义解码：~0 → ~、~1 → /；其他 ~x 非法。 */
const unescapeToken = (token: string): string | null => {
  let result = '';
  for (let i = 0; i < token.length; i += 1) {
    const char = token.charAt(i);
    if (char !== '~') {
      result += char;
      continue;
    }
    const next = token[i + 1];
    if (next === '0') {
      result += '~';
      i += 1;
    } else if (next === '1') {
      result += '/';
      i += 1;
    } else {
      return null;
    }
  }
  return result;
};

/**
 * RFC 6901 解析为 token 数组（未转义）。必须以 `/` 开头且无空 token；
 * 非法转义返回 null。空字符串（整文档指针）不属于锁定/编辑路径口径，拒绝。
 */
export const parseLockPointer = (pointer: string): readonly string[] | null => {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer.includes('//')) {
    return null;
  }
  const rawTokens = pointer.slice(1).split('/');
  const tokens: string[] = [];
  for (const raw of rawTokens) {
    if (raw.length === 0) return null;
    const token = unescapeToken(raw);
    if (token === null || token.length === 0) return null;
    tokens.push(token);
  }
  return tokens;
};

const isArrayIndexToken = (token: string): boolean => /^(0|[1-9][0-9]*)$/.test(token);

/**
 * 锁路径静态校验（不依赖具体文档）：结构合法、根在七根白名单内、无数组下标 token。
 */
export const checkLockPointer = (pointer: string): LockPointerCheck => {
  const tokens = parseLockPointer(pointer);
  if (tokens === null) {
    return { code: 'LOCK_POINTER_MALFORMED', detail: pointer, ok: false };
  }
  const root = tokens[0];
  const rest = tokens.slice(1);
  if (root === undefined || !(LOCKABLE_ROOTS as readonly string[]).includes(root)) {
    return { code: 'LOCK_ROOT_NOT_LOCKABLE', detail: pointer, ok: false };
  }
  if (rest.some(isArrayIndexToken)) {
    return { code: 'LOCK_ARRAY_INDEX_FORBIDDEN', detail: pointer, ok: false };
  }
  return { ok: true, tokens };
};

const resolvesIn = (document: unknown, tokens: readonly string[]): boolean => {
  let current: unknown = document;
  for (const token of tokens) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return false;
    const holder = current as Readonly<Record<string, unknown>>;
    if (!(token in holder)) return false;
    current = holder[token];
  }
  return true;
};

/**
 * 锁路径完整校验：静态规则 + 必须能在当前版本文档解析（不存在路径不保存）。
 */
export const validateLockPointer = (pointer: string, document: unknown): LockPointerCheck => {
  const check = checkLockPointer(pointer);
  if (!check.ok) return check;
  if (!resolvesIn(document, check.tokens)) {
    return { code: 'LOCK_PATH_UNRESOLVED', detail: pointer, ok: false };
  }
  return check;
};

/**
 * 锁/写 token 前缀冲突判定：一方是另一方前缀，或相等，均视为冲突
 * （TECH §9.2：锁路径是写路径的父路径、写路径是锁路径的父路径，或两者相等）。
 */
export const pointerTokensConflict = (
  lockTokens: readonly string[],
  writeTokens: readonly string[],
): boolean => {
  const shared = Math.min(lockTokens.length, writeTokens.length);
  for (let i = 0; i < shared; i += 1) {
    if (lockTokens[i] !== writeTokens[i]) return false;
  }
  return true;
};

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Readonly<Record<string, unknown>>;
  const right = b as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]),
    )
  );
};

/**
 * 编辑器场景写集推导：比较当前文档与编辑后文档在可编辑根下的取值，
 * 返回发生变化的根名集合（写集以根级粒度计；键序无关）。
 * 系统字段（ID/版本/状态/provenance 等）不在可编辑根内，差异被忽略。
 */
export const changedEditableRoots = (
  currentDocument: Readonly<Record<string, unknown>>,
  editedDocument: Readonly<Record<string, unknown>>,
): readonly string[] =>
  EDITABLE_ROOTS.filter((root) => !deepEqual(currentDocument[root], editedDocument[root]));
