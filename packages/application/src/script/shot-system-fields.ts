/**
 * SHOT_CONTRACT 系统字段注入（design.md D2）。
 *
 * 模型只提供镜头创意字段；本模块显式挑选已知创意键并注入标识/版本/溯源/派生
 * 常量。模型额外输出的键（含伪造的 shot_id、status 等系统字段）一律丢弃，
 * 与候选契约「忽略模型提供的系统字段值并以注入值为准」语义一致。
 */

import type { DialogueRenderMode } from '../ports/script';

export interface ShotSystemFieldContext {
  /** 逐镜头 shot_id 工厂（第 i 个镜头，0 起；每个镜头恰好调用一次，结果同时用于
   * shot_id 与 previous_shot_id 派生，避免真实 newId() 下两次调用产生不一致引用）。 */
  readonly newShotId: (index: number) => string;
  /** 逐镜头 version_id 工厂（第 i 个镜头，0 起，恰好一次）；结果必须满足 scv_*_v1 列绑定 CHECK。 */
  readonly newVersionId: (index: number) => string;
  readonly formatProfileId: string;
  readonly invocationId: string;
}

export interface DialogueFlags {
  readonly audioRequired: boolean;
  readonly lipSyncRequired: boolean;
}

/**
 * 按 ShotContract 1.1.0 allOf 规则从 (spoken_text, dialogue_render_mode) 确定性推导
 * audio_required / lip_sync_required；推导值与 Schema 规定的精确值一一对应。
 */
export const deriveDialogueFlags = (input: {
  readonly renderMode: unknown;
  readonly spokenText: unknown;
}): DialogueFlags | null => {
  const spoken = typeof input.spokenText === 'string' && input.spokenText.length > 0;
  switch (input.renderMode) {
    case 'SUBTITLE_ONLY':
      return { audioRequired: false, lipSyncRequired: false };
    case 'NARRATION_FIRST':
      return spoken
        ? { audioRequired: true, lipSyncRequired: false }
        : { audioRequired: false, lipSyncRequired: false };
    case 'WEAK_LIP_SYNC':
      return spoken
        ? { audioRequired: true, lipSyncRequired: false }
        : { audioRequired: false, lipSyncRequired: false };
    case 'PRECISE_LIP_SYNC':
      return spoken
        ? { audioRequired: true, lipSyncRequired: true }
        : { audioRequired: false, lipSyncRequired: false };
    default:
      return null;
  }
};

const CINEMATOGRAPHY_KEYS = [
  'shot_size',
  'camera_angle',
  'composition',
  'focus',
  'camera_motion',
  'frontal_face',
  'mouth_visible',
] as const;

const CONTENT_KEYS = [
  'character_ids',
  'scene_id',
  'prop_ids',
  'action',
  'emotion',
  'spoken_text',
] as const;

const pick = (
  source: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, unknown>> => {
  const picked: Record<string, unknown> = {};
  for (const key of keys) picked[key] = source[key];
  return picked;
};

/**
 * 将候选集合 `{data:{shots:[...]}}` 注入为逐镜头 ShotContract 文档数组。
 * 任一镜头缺创意键或 render mode 不可推导时抛错（属 SYSTEM_FIELDS 层失败，
 * 正常流程中候选契约已在前置层拦截，此处为防御性兜底）。
 */
export const injectShotSystemFields = (
  candidate: unknown,
  context: ShotSystemFieldContext,
): readonly Readonly<Record<string, unknown>>[] => {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error('SHOT_CANDIDATE_NOT_OBJECT');
  }
  const data = (candidate as Readonly<{ data?: unknown }>).data;
  if (typeof data !== 'object' || data === null) {
    throw new Error('SHOT_CANDIDATE_NOT_OBJECT');
  }
  const shots = (data as Readonly<{ shots?: unknown }>).shots;
  if (!Array.isArray(shots) || shots.length === 0) {
    throw new Error('SHOT_CANDIDATE_SHOTS_INVALID');
  }
  // previous_shot_id 由系统派生（CONTINUOUS_ACTION → sequence-1 的 shot_id）：
  // 模型无法得知系统注入的兄弟镜头 id，其输出值一律丢弃。首镜头派生为 null，
  // 由集合校验层以有界明细报「CONTINUOUS_ACTION 需要前置镜头」。
  const shotIds = shots.map((_, index) => context.newShotId(index));

  return shots.map((shot, index) => {
    if (typeof shot !== 'object' || shot === null || Array.isArray(shot)) {
      throw new Error('SHOT_CANDIDATE_SHOT_INVALID');
    }
    const fields = shot as Readonly<Record<string, unknown>>;
    for (const key of [
      'narrative_purpose',
      'target_duration_sec',
      'cinematography',
      'content',
      'dialogue',
      'continuity',
      'generation_constraints',
      'acceptance',
    ]) {
      if (
        typeof fields[key] !== 'object' &&
        !(key === 'narrative_purpose' && typeof fields[key] === 'string') &&
        !(key === 'target_duration_sec' && typeof fields[key] === 'number')
      ) {
        throw new Error('SHOT_CANDIDATE_CREATIVE_FIELD_INVALID');
      }
    }
    const dialogue = fields.dialogue as Readonly<Record<string, unknown>>;
    const content = fields.content as Readonly<Record<string, unknown>>;
    const spoken = typeof content.spoken_text === 'string' && content.spoken_text.length > 0;
    const renderMode = dialogue.dialogue_render_mode as DialogueRenderMode;
    const flags = deriveDialogueFlags({
      renderMode,
      spokenText: content.spoken_text,
    });
    if (flags === null) throw new Error('SHOT_DIALOGUE_MODE_INVALID');

    const cinematography = pick(
      fields.cinematography as Readonly<Record<string, unknown>>,
      CINEMATOGRAPHY_KEYS,
    );
    const pickedContent = pick(content, CONTENT_KEYS);
    const pickedDialogue = pick(dialogue, [
      'dialogue_render_mode',
      'speaker_id',
      'estimated_speech_duration_sec',
    ]);
    const continuity = pick(fields.continuity as Readonly<Record<string, unknown>>, [
      'continuity_mode',
      'first_frame_requirement',
      'last_frame_requirement',
    ]);
    const constraints = pick(fields.generation_constraints as Readonly<Record<string, unknown>>, [
      'capability_requirements',
      'image_prompt',
      'video_prompt',
      'negative_constraints',
    ]);
    const acceptance = pick(fields.acceptance as Readonly<Record<string, unknown>>, [
      'must_include',
      'must_not_include',
    ]);

    return {
      acceptance: { ...acceptance, human_review_required: true },
      cinematography,
      content: pickedContent,
      continuity: {
        ...continuity,
        asset_version_ids: [],
        previous_shot_id:
          continuity.continuity_mode === 'CONTINUOUS_ACTION' && index > 0
            ? (shotIds[index - 1] ?? null)
            : null,
      },
      contract_version: 1,
      dialogue: {
        ...pickedDialogue,
        audio_required: flags.audioRequired,
        dialogue_mode_source: 'PROJECT_DEFAULT',
        // Schema allOf 强制 NARRATION_FIRST 且有台词时 speaker 恒为 narrator；模型给错必被
        // 正式校验拒绝且不可修复，故由系统直接推导，不信任模型该字段。
        speaker_id: renderMode === 'NARRATION_FIRST' && spoken ? 'narrator' : dialogue.speaker_id,
        lip_sync_required: flags.lipSyncRequired,
        override_reason: null,
      },
      derived_from_shot_ids: [],
      format_profile_id: context.formatProfileId,
      generation_constraints: {
        ...constraints,
        budget_estimate: {
          currency_or_credit: 'UNKNOWN',
          is_estimate: true,
          max: null,
          min: null,
          price_version: null,
        },
      },
      locked_paths: [],
      narrative_purpose: fields.narrative_purpose,
      parent_version_id: null,
      provenance: {
        last_edit_source: 'AI',
        source_invocation_id: context.invocationId,
        source_type: 'AI_GENERATED',
      },
      schema_version: '1.1.0',
      sequence: index + 1,
      shot_id: shotIds[index],
      // 每镜头节奏属创意决策，模型提供数值；1–20 的取值边界由 FINAL 层 schema 定界。
      target_duration_sec: fields.target_duration_sec,
      status: 'DRAFT',
      version_id: context.newVersionId(index),
    };
  });
};
