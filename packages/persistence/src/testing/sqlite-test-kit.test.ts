import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FIXED_TEST_TIME, withSqliteTestContext } from './sqlite-test-kit';

describe('SQLite 测试上下文', () => {
  it('创建测试上下文—读取路径和确定性输入—仅使用系统临时目录', async () => {
    await withSqliteTestContext((context) => {
      expect(path.dirname(context.root)).toBe(os.tmpdir());
      expect(context.clock()).toBe(FIXED_TEST_TIME);
      expect(context.createId('fixture')).toBe('fixture_0001');
      expect(context.createId('fixture')).toBe('fixture_0002');
    });
  });
});
