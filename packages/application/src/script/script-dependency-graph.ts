import type { StagedScriptStage } from '../ports/script/index';

const STAGE_ORDER: readonly StagedScriptStage[] = Object.freeze([
  'CONCEPT',
  'STORY_BIBLE',
  'EPISODE_OUTLINE',
  'BEAT_SHEET',
  'SCENE_SCRIPT',
]);

const DIRECT_DEPENDENTS: Readonly<Record<StagedScriptStage, readonly StagedScriptStage[]>> =
  Object.freeze({
    BEAT_SHEET: Object.freeze(['SCENE_SCRIPT']),
    CONCEPT: Object.freeze(['STORY_BIBLE', 'EPISODE_OUTLINE']),
    EPISODE_OUTLINE: Object.freeze(['BEAT_SHEET']),
    SCENE_SCRIPT: Object.freeze([]),
    STORY_BIBLE: Object.freeze(['EPISODE_OUTLINE', 'BEAT_SHEET', 'SCENE_SCRIPT']),
  } satisfies Record<StagedScriptStage, readonly StagedScriptStage[]>);

/** Returns the fixed transitive invalidation order without consulting the model. */
export const listInvalidatedStages = (
  upstream: StagedScriptStage,
): readonly StagedScriptStage[] => {
  const discovered = new Set<StagedScriptStage>();
  const queue = [...DIRECT_DEPENDENTS[upstream]];
  while (queue.length > 0) {
    const stage = queue.shift();
    if (stage === undefined || discovered.has(stage)) continue;
    discovered.add(stage);
    queue.push(...DIRECT_DEPENDENTS[stage]);
  }
  return STAGE_ORDER.filter((stage) => discovered.has(stage));
};

export const isProjectStage = (stage: StagedScriptStage): boolean =>
  stage === 'CONCEPT' || stage === 'STORY_BIBLE';
