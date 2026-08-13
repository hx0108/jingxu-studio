import { describe, expect, it } from 'vitest';

import { assertJobTransition, JobInvariantError } from './job-state-guard';

describe('Job 状态与次数应用级不变量', () => {
  it('合法回环—次数满足边界—允许 transport retry 与唯一 structure repair', () => {
    expect(() => {
      assertJobTransition('RUNNING', 'RUNNING', 1, 0);
    }).not.toThrow();
    expect(() => {
      assertJobTransition('VALIDATING', 'RUNNING', 1, 1);
    }).not.toThrow();
  });

  it.each([
    ['RUNNING', 'RUNNING', 0, 0],
    ['VALIDATING', 'RUNNING', 1, 0],
    ['SUCCEEDED', 'RUNNING', 1, 0],
    ['RUNNING', 'VALIDATING', 4, 0],
    ['VALIDATING', 'FAILED', 0, 2],
  ] as const)('越界转移 %s→%s (%i/%i)—应用守卫稳定拒绝', (from, to, transport, repair) => {
    expect(() => {
      assertJobTransition(from, to, transport, repair);
    }).toThrow(JobInvariantError);
  });
});
