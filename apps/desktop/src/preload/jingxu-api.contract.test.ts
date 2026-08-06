import { describe, expect, expectTypeOf, it } from 'vitest';

import type { JingxuApi } from '@jingxu/contracts';

import { createJingxuApi } from './jingxu-api';

describe('window.jingxu 白名单 Contract', () => {
  it('首个 Change 尚无业务用例时—创建公开 API—得到冻结空对象', () => {
    const api = createJingxuApi();

    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api)).toEqual([]);
    expectTypeOf(api).toEqualTypeOf<JingxuApi>();
  });

  it.each(['send', 'on', 'once', 'invoke'])(
    '首个 Change 尚无业务 IPC 时—检查 %s—不存在通用频道入口',
    (methodName) => {
      expect(Reflect.has(createJingxuApi(), methodName)).toBe(false);
    },
  );
});
