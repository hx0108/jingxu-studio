import type { ModelErrorCode } from '@jingxu/application';

import type { MockVideoSubmitStep } from '@jingxu/model-adapters';
import { createMockModelError } from '@jingxu/model-adapters';
import { MEDIA_BATCH_MAX_SHOTS } from '@jingxu/contracts';

/** ARK Key 的 safeStorage 凭据引用（视频独立档，与图片档分存；design D2）。 */
export const VIDEO_CREDENTIAL_ID = 'profile-video-primary';
/** 每轮候选数 N（拍板 D3）。 */
export const VIDEO_CANDIDATE_COUNT = 2;
/** ASYNC Provider 单候选轮询截止：视频段生成远慢于图片，分钟级预算。 */
export const VIDEO_POLL_DEADLINE_MS = 15 * 60_000;
export const VIDEO_POLL_INTERVAL_MS = 3_000;

/**
 * E2E 视频 Mock 步骤脚本化（仅 useE2eMock 下消费）：JINGXU_E2E_VIDEO_STEPS 为逗号
 * 分隔令牌（design A3）——`A`=ASYNC 2 次 PENDING 轮询后 SUCCEEDED（默认轮询窗口）、
 * `A:800`=submit 延迟 800ms 的慢异步（制造在飞窗口，供取消/重启场景抢占）、
 * `A:P3`=3 次 PENDING、`A:P0`=首次 poll 即 SUCCEEDED（快速路径）、`A:800:P3`=组合、
 * `E:MODEL_TIMEOUT`=submit 期候选级失败、`T:800`=800ms 后超时。缺省回落全 `A`
 * 预算（单批上限 20 镜头 × 2 候选，兼作失控循环熔断）；非法令牌启动期即抛——
 * 失败要响，不带病运行。
 */
export const parseE2eVideoSteps = (): readonly MockVideoSubmitStep[] => {
  const raw = process.env.JINGXU_E2E_VIDEO_STEPS;
  if (raw === undefined || raw.trim() === '') {
    return Array.from(
      { length: VIDEO_CANDIDATE_COUNT * MEDIA_BATCH_MAX_SHOTS },
      () => ({ kind: 'ASYNC', pendingPolls: 2 }) as const,
    );
  }
  return raw.split(',').map((token): MockVideoSubmitStep => {
    const trimmed = token.trim();
    const failure = /^E:([A-Z][A-Z0-9_]*)$/u.exec(trimmed);
    if (failure !== null) {
      return { error: createMockModelError(failure[1] as ModelErrorCode), kind: 'ERROR' };
    }
    const timeout = /^T:(\d+)$/u.exec(trimmed);
    if (timeout !== null) {
      return { afterMs: Number(timeout[1] ?? 0), kind: 'TIMEOUT' };
    }
    const asyncStep = /^A(?::(\d+))?(?::P(\d+))?$/u.exec(trimmed);
    if (asyncStep !== null) {
      const afterMs = Number(asyncStep[1] ?? 0);
      const pendingPolls = Number(asyncStep[2] ?? 2);
      return {
        ...(afterMs > 0 ? { afterMs } : {}),
        kind: 'ASYNC',
        pendingPolls,
      };
    }
    throw new Error(`JINGXU_E2E_VIDEO_STEPS_INVALID_TOKEN: ${trimmed}`);
  });
};
