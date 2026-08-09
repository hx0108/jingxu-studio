import { describe, expect, it } from 'vitest';

import { monotonicUpdatedAt } from './monotonic-timestamp';

const TS = '2026-08-09T12:00:00.000Z';
const TS_MILLIS = Date.parse(TS);

describe('monotonicUpdatedAt — 单调 revision（Design §6）', () => {
  it('previousUpdatedAt 为 null（创建）—取 now', () => {
    expect(monotonicUpdatedAt(TS_MILLIS, null)).toBe(TS);
  });

  it('now 晚于 previous+1ms—取 now', () => {
    const earlier = '2026-08-09T11:59:59.000Z';
    expect(monotonicUpdatedAt(TS_MILLIS, earlier)).toBe(TS);
  });

  it('now 等于 previous（同毫秒连续写入）—取 previous+1ms 保证严格递增', () => {
    expect(monotonicUpdatedAt(TS_MILLIS, TS)).toBe('2026-08-09T12:00:00.001Z');
  });

  it('now 早于 previous（时钟回退）—仍取 previous+1ms', () => {
    const regressed = TS_MILLIS - 1000;
    expect(monotonicUpdatedAt(regressed, TS)).toBe('2026-08-09T12:00:00.001Z');
  });

  it('同毫秒内连续三次写入—revision 每次严格递增', () => {
    const first = monotonicUpdatedAt(TS_MILLIS, null);
    const second = monotonicUpdatedAt(TS_MILLIS, first);
    const third = monotonicUpdatedAt(TS_MILLIS, second);
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
    expect(Date.parse(third)).toBeGreaterThan(Date.parse(second));
  });
});
