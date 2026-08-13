export const MODEL_SCRIPT_STAGE_CANDIDATE_SCHEMA_ID =
  'https://jingxu.studio/schemas/internal/ModelScriptStageCandidate/v1';

export interface ModelScriptStageCandidate {
  readonly data: Readonly<Record<string, unknown>>;
}

export type ModelScriptCandidateStage =
  'CONCEPT' | 'STORY_BIBLE' | 'EPISODE_OUTLINE' | 'BEAT_SHEET' | 'SCENE_SCRIPT';

const REQUIRED_DATA_KEYS: Readonly<Record<ModelScriptCandidateStage, readonly string[]>> = {
  BEAT_SHEET: ['beats'],
  CONCEPT: ['title', 'genre', 'target_audience', 'core_conflict', 'theme', 'synopsis'],
  EPISODE_OUTLINE: [
    'episode_goal',
    'opening',
    'midpoint',
    'climax',
    'ending_hook',
    'target_duration_sec',
  ],
  SCENE_SCRIPT: ['scenes'],
  STORY_BIBLE: ['characters', 'world_rules', 'scenes', 'props'],
};

export interface CandidateValidationResult {
  readonly ok: boolean;
  readonly errorCode:
    'CANDIDATE_NOT_OBJECT' | 'CANDIDATE_UNKNOWN_FIELD' | 'CANDIDATE_DATA_INVALID' | null;
}

/**
 * Validates the model-only envelope. Stage-specific data constraints remain in the formal
 * ScriptStageOutput validation after trusted system metadata is injected.
 */
export const validateModelScriptStageCandidate = (
  stage: ModelScriptCandidateStage,
  value: unknown,
): CandidateValidationResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { errorCode: 'CANDIDATE_NOT_OBJECT', ok: false };
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'data') {
    return { errorCode: 'CANDIDATE_UNKNOWN_FIELD', ok: false };
  }
  const data = (value as Readonly<{ data?: unknown }>).data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { errorCode: 'CANDIDATE_DATA_INVALID', ok: false };
  }
  const fields = data as Readonly<Record<string, unknown>>;
  if (REQUIRED_DATA_KEYS[stage].some((key) => !(key in fields))) {
    return { errorCode: 'CANDIDATE_DATA_INVALID', ok: false };
  }
  return { errorCode: null, ok: true };
};
