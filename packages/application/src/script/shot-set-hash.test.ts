import { describe, expect, it } from 'vitest';

import { type ShotSetHashEntry, computeShotSetHash } from './shot-set-hash';

const entries = (): readonly ShotSetHashEntry[] => [
  { sequence: 1, shotId: 'shot_a', shotVersionId: 'shotv_a1', documentSha256: 'sha_a' },
  { sequence: 2, shotId: 'shot_b', shotVersionId: 'shotv_b1', documentSha256: 'sha_b' },
  { sequence: 3, shotId: 'shot_c', shotVersionId: 'shotv_c1', documentSha256: 'sha_c' },
];

const SERIALIZED =
  '[["shot_a","shotv_a1","sha_a"],["shot_b","shotv_b1","sha_b"],["shot_c","shotv_c1","sha_c"]]';

describe('computeShotSetHash', () => {
  it('条件—同一集合—传给 hashText 的输入固定为按 sequence 排序的三元组 JSON，结果可重复', () => {
    const seen: string[] = [];
    const capture = (text: string): string => {
      seen.push(text);
      return 'h'.repeat(64);
    };

    const first = computeShotSetHash(entries(), capture);
    const second = computeShotSetHash(entries(), capture);

    expect(first).toBe(second);
    // 序列化形态即与 hashDocument 的同源边界：sha256(JSON.stringify(…)) 由注入的
    // hashText（组合根 sha256Text）承担，此处钉死它收到的精确字符串。
    expect(seen).toEqual([SERIALIZED, SERIALIZED]);
  });

  it('条件—传入乱序 entries—先按 sequence 排序再哈希，与有序输入同值', () => {
    const reversed = [...entries()].reverse();
    expect(computeShotSetHash(reversed, (text) => text)).toBe(
      computeShotSetHash(entries(), (text) => text),
    );
  });

  it('条件—任一三元组分量变化或镜头顺序交换—哈希结果不同', () => {
    const base = entries();
    const changedDocument = base.map((entry, index) =>
      index === 1 ? { ...entry, documentSha256: 'sha_b2' } : entry,
    );
    const changedVersion = base.map((entry, index) =>
      index === 2 ? { ...entry, shotVersionId: 'shotv_c2' } : entry,
    );
    const swappedOrder = base.map((entry) =>
      entry.sequence === 1
        ? { ...entry, sequence: 2 }
        : entry.sequence === 2
          ? { ...entry, sequence: 1 }
          : entry,
    );

    const hash = (value: readonly ShotSetHashEntry[]): string =>
      computeShotSetHash(value, (text) => text);
    expect(hash(changedDocument)).not.toBe(hash(base));
    expect(hash(changedVersion)).not.toBe(hash(base));
    // 同一批 shot 版本仅展示顺序互换也必须改变哈希——sequence 是集合身份的一部分。
    expect(hash(swappedOrder)).not.toBe(hash(base));
  });

  it('条件—空集合—序列化为空数组字符串而非空串，交由调用方决定是否为合法集合', () => {
    const seen: string[] = [];
    computeShotSetHash([], (text) => {
      seen.push(text);
      return 'h'.repeat(64);
    });
    expect(seen).toEqual(['[]']);
  });
});
