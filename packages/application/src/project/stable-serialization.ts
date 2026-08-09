import type { StableHasher } from '../ports/project/service-dependencies';

/**
 * v1 canonical JSON 稳定序列化（Design §4、§2.5）。
 *
 * 对象 key 按 code unit 升序递归排序，输出紧凑无空白；数组顺序保留。任意属性顺序的
 * 同一逻辑值产出同一字符串，使 SHA-256 摘要稳定，支撑 Command 幂等回执的 payloadSha256
 * 与列表游标的 searchHash。
 */

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  return value;
};

/** 规范化对象为稳定、紧凑的 JSON 字符串。 */
export const canonicalSerialize = (value: object): string => JSON.stringify(canonicalize(value));

/**
 * 构造 StableHasher：先 canonicalSerialize 再交由注入的 sha256 摘要。
 *
 * sha256 由调用方注入（生产为 node:crypto 的 SHA-256，返回 64 位小写 hex；测试用确定性
 * Fake），使本模块保持纯 ES/DOM、不引入 Node crypto 依赖，便于在任意 vitest 环境运行。
 */
export const createStableHasher = (sha256: (input: string) => string): StableHasher => ({
  hash: (value: object) => sha256(canonicalSerialize(value)),
});
