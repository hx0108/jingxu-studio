import { z } from 'zod';

/**
 * AI 分阶段生成的剧本/分镜阶段（TECH_DESIGN v1.1 §3.3、§6.1.1）。
 *
 * 枚举值与 `prompt_templates.stage`、`script_stage_jobs.stage` 的数据库 CHECK
 * 约束保持一致；`SHOT_CONTRACT` 属于分镜阶段，由后续 Change 接入，本 Change
 * 的 JobRunner 与 TextModelAdapter 不对其赋予额外业务语义。
 */
export const scriptStageSchema = z.enum([
  'CONCEPT',
  'STORY_BIBLE',
  'EPISODE_OUTLINE',
  'BEAT_SHEET',
  'SCENE_SCRIPT',
  'SHOT_CONTRACT',
]);
export type ScriptStage = z.infer<typeof scriptStageSchema>;
