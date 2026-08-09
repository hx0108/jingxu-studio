import type { Clock } from '../ports/project/service-dependencies';

/**
 * 单调 updatedAt 计算（Design §6）。
 *
 * 取 `max(nowMillis, Date.parse(previousUpdatedAt) + 1)`：时钟正常前进时用当前时间，
 * 同毫秒连续写入或时钟回退时以前次 +1ms 推进，保证 revision 严格递增、不产生重复
 * updatedAt。previousUpdatedAt 为 null（创建首个 Project）时下界为 0。
 *
 * @param nowMillis 当前 Unix epoch 毫秒（来自注入的 Clock.now()）
 * @param previousUpdatedAt 前次 updatedAt；创建时为 null
 * @returns 带时区的 ISO-8601 字符串
 */
export const monotonicUpdatedAt = (nowMillis: number, previousUpdatedAt: string | null): string => {
  const floor = previousUpdatedAt === null ? 0 : Date.parse(previousUpdatedAt) + 1;
  return new Date(Math.max(nowMillis, floor)).toISOString();
};

/**
 * 生产 Clock 实现：Date.now 薄包装。
 *
 * 由 Composition Root 注入 ProjectService；测试使用确定性 FakeClock 固定时间，不依赖本实现。
 */
export const createSystemClock = (): Clock => ({
  now: () => Date.now(),
});
