import type { ScriptStage } from '@jingxu/contracts';

/**
 * 文本调用按阶段的时限策略（image-credential-management D3 拍板：SHOT_CONTRACT
 * 为 9 镜头重 JSON 长尾阶段，120 秒上限实测 5/8 超时）。JobRunner 的
 * `timeout_at`/`deadline_at` 与 Qwen 适配器的 AbortSignal 超时共用此常量，
 * 避免两处漂移。
 */
export const STAGE_INVOCATION_TIMEOUT_MS: Readonly<Record<ScriptStage, number>> = Object.freeze({
  BEAT_SHEET: 120_000,
  CONCEPT: 120_000,
  EPISODE_OUTLINE: 120_000,
  SCENE_SCRIPT: 120_000,
  SHOT_CONTRACT: 300_000,
  STORY_BIBLE: 120_000,
});

/** 领取时落库的墙钟预算：SHOT_CONTRACT 300×3+60（覆盖 1+1 次满超时调用与余量），其余 300 秒。 */
export const STAGE_DEADLINE_MS: Readonly<Record<ScriptStage, number>> = Object.freeze({
  BEAT_SHEET: 300_000,
  CONCEPT: 300_000,
  EPISODE_OUTLINE: 300_000,
  SCENE_SCRIPT: 300_000,
  SHOT_CONTRACT: 960_000,
  STORY_BIBLE: 300_000,
});
