export const MODEL_SHOT_SET_CANDIDATE_SCHEMA_ID =
  'https://jingxu.studio/schemas/internal/ModelShotSetCandidate/v1';

/** SHOT_CONTRACT 模型候选：模型只产出镜头创意字段，集合由系统注入标识/版本/派生常量。 */
export interface ModelShotSetCandidate {
  readonly data: Readonly<{ shots: readonly unknown[] }>;
}

export interface ShotCandidateValidationResult {
  readonly ok: boolean;
  readonly errorCode:
    'CANDIDATE_NOT_OBJECT' | 'CANDIDATE_UNKNOWN_FIELD' | 'CANDIDATE_DATA_INVALID' | null;
  /** 缺失键定位（shots[i].group.key）；明细截断由候选契约管线统一执行。 */
  readonly details?: readonly string[];
}

/** 模型必须提供的镜头顶层创意键（分组对象 + 一个平铺字段）。 */
const SHOT_CREATIVE_KEYS = [
  'narrative_purpose',
  'cinematography',
  'content',
  'dialogue',
  'continuity',
  'generation_constraints',
  'acceptance',
] as const;

/** 各分组内模型必须提供的创意键；系统字段（mode_source、budget、locked_paths 等）不在此列。 */
const SHOT_CREATIVE_GROUP_KEYS: Readonly<Record<string, readonly string[]>> = {
  acceptance: ['must_include', 'must_not_include'],
  cinematography: [
    'shot_size',
    'camera_angle',
    'composition',
    'focus',
    'camera_motion',
    'frontal_face',
    'mouth_visible',
  ],
  content: ['character_ids', 'scene_id', 'prop_ids', 'action', 'emotion', 'spoken_text'],
  continuity: [
    'continuity_mode',
    'previous_shot_id',
    'first_frame_requirement',
    'last_frame_requirement',
  ],
  dialogue: ['dialogue_render_mode', 'speaker_id', 'estimated_speech_duration_sec'],
  generation_constraints: [
    'capability_requirements',
    'image_prompt',
    'video_prompt',
    'negative_constraints',
  ],
};

/**
 * 校验 SHOT_CONTRACT 模型候选信封与逐镜头创意键存在性。键缺失属可修复失败
 * （CANDIDATE_SCHEMA 层）；取值与跨字段语义仍由注入后的 ShotContract 1.1.0 正式校验约束。
 */
export const validateModelShotSetCandidate = (value: unknown): ShotCandidateValidationResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { errorCode: 'CANDIDATE_NOT_OBJECT', ok: false };
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'data') {
    return { errorCode: 'CANDIDATE_UNKNOWN_FIELD', ok: false };
  }
  const data = (value as Readonly<{ data?: unknown }>).data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { errorCode: 'CANDIDATE_DATA_INVALID', details: ['data'], ok: false };
  }
  const shots = (data as Readonly<{ shots?: unknown }>).shots;
  if (!Array.isArray(shots) || shots.length === 0) {
    return { errorCode: 'CANDIDATE_DATA_INVALID', details: ['data.shots'], ok: false };
  }

  const missing: string[] = [];
  shots.forEach((shot, index) => {
    if (typeof shot !== 'object' || shot === null || Array.isArray(shot)) {
      missing.push(`shots[${String(index)}]`);
      return;
    }
    const fields = shot as Readonly<Record<string, unknown>>;
    for (const key of SHOT_CREATIVE_KEYS) {
      if (!(key in fields)) missing.push(`shots[${String(index)}].${key}`);
    }
    for (const [group, groupKeys] of Object.entries(SHOT_CREATIVE_GROUP_KEYS)) {
      const value = fields[group];
      if (!(group in fields) || typeof value !== 'object' || value === null) continue;
      for (const key of groupKeys) {
        if (!(key in (value as Readonly<Record<string, unknown>>))) {
          missing.push(`shots[${String(index)}].${group}.${key}`);
        }
      }
    }
  });
  if (missing.length > 0) {
    return { errorCode: 'CANDIDATE_DATA_INVALID', details: missing, ok: false };
  }
  return { errorCode: null, ok: true };
};
