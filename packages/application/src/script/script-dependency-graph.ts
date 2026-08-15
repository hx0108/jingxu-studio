import type { ScriptStage } from '@jingxu/contracts';

import type { StagedScriptStage } from '../ports/script/index';

const STAGE_ORDER: readonly ScriptStage[] = Object.freeze([
  'CONCEPT',
  'STORY_BIBLE',
  'EPISODE_OUTLINE',
  'BEAT_SHEET',
  'SCENE_SCRIPT',
  'SHOT_CONTRACT',
]);

// SHOT_CONTRACT 的冻结输入为 STORY_BIBLE + EPISODE_OUTLINE + SCENE_SCRIPT + format_profile
// （shot-contract-generation design.md D5），故三者 READY 变更均直接失效分镜整集。
const DIRECT_DEPENDENTS: Readonly<Record<ScriptStage, readonly ScriptStage[]>> = Object.freeze({
  BEAT_SHEET: Object.freeze(['SCENE_SCRIPT']),
  CONCEPT: Object.freeze(['STORY_BIBLE', 'EPISODE_OUTLINE']),
  EPISODE_OUTLINE: Object.freeze(['BEAT_SHEET', 'SHOT_CONTRACT']),
  SCENE_SCRIPT: Object.freeze(['SHOT_CONTRACT']),
  SHOT_CONTRACT: Object.freeze([]),
  STORY_BIBLE: Object.freeze(['EPISODE_OUTLINE', 'BEAT_SHEET', 'SCENE_SCRIPT', 'SHOT_CONTRACT']),
} satisfies Record<ScriptStage, readonly ScriptStage[]>);

/** Returns the fixed transitive invalidation order without consulting the model. */
export const listInvalidatedStages = (upstream: StagedScriptStage): readonly ScriptStage[] => {
  const discovered = new Set<ScriptStage>();
  const queue = [...DIRECT_DEPENDENTS[upstream]];
  while (queue.length > 0) {
    const stage = queue.shift();
    if (stage === undefined || discovered.has(stage)) continue;
    discovered.add(stage);
    queue.push(...DIRECT_DEPENDENTS[stage]);
  }
  return STAGE_ORDER.filter((stage) => discovered.has(stage));
};

/** 项目级阶段（episodeId 必须为 null）；SHOT_CONTRACT 属集级，恒为 false。 */
export const isProjectStage = (stage: ScriptStage): boolean =>
  stage === 'CONCEPT' || stage === 'STORY_BIBLE';
