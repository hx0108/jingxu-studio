import { describe, expect, it } from 'vitest';

import { canonicalSerialize, createStableHasher } from './stable-serialization';

describe('canonicalSerialize — v1 canonical JSON', () => {
  it('属性顺序不同但逻辑相等—序列化字节一致', () => {
    const a = { requestId: 'r1', name: '示例', aspectRatio: '9:16' as const };
    const b = { aspectRatio: '9:16', name: '示例', requestId: 'r1' };
    expect(canonicalSerialize(a)).toBe(canonicalSerialize(b));
  });

  it('对象 key 按 code unit 升序输出', () => {
    expect(canonicalSerialize({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it('嵌套对象递归排序 key', () => {
    expect(canonicalSerialize({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('数组元素顺序保留、仅元素内部排序', () => {
    expect(canonicalSerialize({ items: [{ b: 1, a: 2 }, { c: 3 }] })).toBe(
      '{"items":[{"a":2,"b":1},{"c":3}]}',
    );
  });

  it('输出紧凑无空白', () => {
    expect(canonicalSerialize({ a: 1 })).toBe('{"a":1}');
  });
});

describe('createStableHasher — 稳定 hash（注入确定性 sha256）', () => {
  const fakeSha256 = (input: string): string => `hex:${input}`;
  const hasher = createStableHasher(fakeSha256);

  it('同逻辑值不同属性顺序—产出同一摘要', () => {
    const a = { requestId: 'r1', name: 'x', aspectRatio: '9:16' as const };
    const b = { aspectRatio: '9:16', name: 'x', requestId: 'r1' };
    expect(hasher.hash(a)).toBe(hasher.hash(b));
  });

  it('不同值—产出不同摘要', () => {
    expect(hasher.hash({ name: 'a' })).not.toBe(hasher.hash({ name: 'b' }));
  });

  it('摘要基于规范化序列化（顺序归一后）', () => {
    expect(hasher.hash({ b: 1, a: 2 })).toBe(fakeSha256('{"a":2,"b":1}'));
  });
});
