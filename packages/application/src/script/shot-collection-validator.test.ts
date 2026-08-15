import { describe, expect, it } from 'vitest';

import { injectShotSystemFields } from './shot-system-fields';
import { validateShotSetCollection } from './shot-collection-validator';

const context = {
  formatProfileId: 'format-0001',
  invocationId: 'inv-0001',
  newShotId: (index: number) => `shot_gen_${String(index + 1)}`,
  newVersionId: (index: number) => `scv_gen_${String(index + 1)}_v1`,
};

const storyBible = { characterIds: ['char_lin'], sceneIds: ['scene_street'] };

const creativeShot = (
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  acceptance: { must_include: ['雨夜'], must_not_include: [] },
  cinematography: {
    camera_angle: 'EYE_LEVEL',
    camera_motion: 'STATIC',
    composition: '中景构图',
    focus: '前景清晰',
    frontal_face: true,
    mouth_visible: true,
    shot_size: 'MEDIUM',
  },
  content: {
    action: '林然撑伞前行',
    character_ids: ['char_lin'],
    emotion: '焦虑',
    prop_ids: [],
    scene_id: 'scene_street',
    spoken_text: '雨越下越大了。',
  },
  continuity: {
    continuity_mode: 'SCENE_CHANGE',
    first_frame_requirement: '',
    last_frame_requirement: '',
    previous_shot_id: null,
  },
  dialogue: {
    dialogue_render_mode: 'NARRATION_FIRST',
    estimated_speech_duration_sec: 2,
    speaker_id: 'narrator',
  },
  generation_constraints: {
    capability_requirements: [],
    image_prompt: '雨夜街道中景',
    negative_constraints: [],
    video_prompt: '人物缓行',
  },
  narrative_purpose: '建立氛围',
  target_duration_sec: 12,
  ...overrides,
});

const buildDocuments = (
  count: number,
  overrides: Readonly<Record<number, Readonly<Record<string, unknown>>>> = {},
): readonly Readonly<Record<string, unknown>>[] =>
  injectShotSystemFields(
    {
      data: {
        shots: Array.from({ length: count }, (_, index) => creativeShot(overrides[index] ?? {})),
      },
    },
    context,
  );

/** 两层深拷贝，供用例变异 sequence / continuity / content / dialogue。 */
const cloneDocuments = (
  documents: readonly Readonly<Record<string, unknown>>[],
): Record<string, unknown>[] =>
  documents.map((document) => {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(document)) {
      copy[key] =
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? { ...(value as Record<string, unknown>) }
          : value;
    }
    return copy;
  });

const shotAt = (
  documents: Record<string, unknown>[],
  sequence: number,
): Record<string, unknown> => {
  const shot = documents.find((document) => document.sequence === sequence);
  if (shot === undefined) throw new Error('fixture broken');
  return shot;
};

const nested = (shot: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = shot[key];
  if (typeof value !== 'object' || value === null) throw new Error('fixture broken');
  return value as Record<string, unknown>;
};

describe('validateShotSetCollection', () => {
  it('条件—三镜头注入集合（Σ=36s）—通过集合校验', () => {
    expect(validateShotSetCollection(buildDocuments(3), storyBible)).toEqual({ valid: true });
  });

  it('条件—输入非数组或空数组—报 SHOT_SET_SEQUENCE_INVALID', () => {
    expect(validateShotSetCollection('x', storyBible)).toMatchObject({
      code: 'SHOT_SET_SEQUENCE_INVALID',
    });
    expect(validateShotSetCollection([], storyBible)).toMatchObject({
      code: 'SHOT_SET_SEQUENCE_INVALID',
    });
  });

  it('条件—sequence 越界形成缺口—报 SHOT_SET_SEQUENCE_INVALID', () => {
    const documents = cloneDocuments(buildDocuments(3));
    shotAt(documents, 2).sequence = 4;

    const result = validateShotSetCollection(documents, storyBible);
    expect(result).toMatchObject({ code: 'SHOT_SET_SEQUENCE_INVALID', valid: false });
  });

  it('条件—sequence 重复—报 SHOT_SET_SEQUENCE_INVALID', () => {
    const documents = cloneDocuments(buildDocuments(3));
    shotAt(documents, 2).sequence = 1;

    expect(validateShotSetCollection(documents, storyBible)).toMatchObject({
      code: 'SHOT_SET_SEQUENCE_INVALID',
    });
  });

  it('条件—首镜头 CONTINUOUS_ACTION 派生 null—明细指向 seq=1（在 FINAL 之前拦下）', () => {
    const documents = injectShotSystemFields(
      {
        data: {
          shots: [
            creativeShot({ continuity: { continuity_mode: 'CONTINUOUS_ACTION' } }),
            creativeShot({ continuity: { continuity_mode: 'CONTINUOUS_ACTION' } }),
          ],
        },
      },
      context,
    );

    const result = validateShotSetCollection(documents, storyBible);
    expect(result).toMatchObject({ code: 'SHOT_SET_PREVIOUS_SHOT_INVALID', valid: false });
    if (!result.valid) expect(result.details[0]).toContain('seq=1');
  });

  it('条件—previous_shot_id 指向自身/更后/集合外—报 SHOT_SET_PREVIOUS_SHOT_INVALID', () => {
    for (const forged of ['shot_gen_1', 'shot_gen_3', 'shot_missing']) {
      const documents = cloneDocuments(buildDocuments(3));
      nested(shotAt(documents, 1), 'continuity').previous_shot_id = forged;

      expect(validateShotSetCollection(documents, storyBible)).toMatchObject({
        code: 'SHOT_SET_PREVIOUS_SHOT_INVALID',
      });
    }
  });

  it('条件—previous_shot_id 回指 sequence-1—通过', () => {
    const documents = cloneDocuments(buildDocuments(3));
    nested(shotAt(documents, 2), 'continuity').previous_shot_id = 'shot_gen_1';

    expect(validateShotSetCollection(documents, storyBible)).toEqual({ valid: true });
  });

  it('条件—角色或说话人不在冻结 STORY_BIBLE—报 SHOT_SET_CHARACTER_UNKNOWN', () => {
    const character = cloneDocuments(buildDocuments(2));
    nested(shotAt(character, 1), 'content').character_ids = ['char_lin', 'char_ghost'];
    expect(validateShotSetCollection(character, storyBible)).toMatchObject({
      code: 'SHOT_SET_CHARACTER_UNKNOWN',
    });

    const speaker = cloneDocuments(buildDocuments(2));
    nested(shotAt(speaker, 1), 'dialogue').speaker_id = 'char_ghost';
    expect(validateShotSetCollection(speaker, storyBible)).toMatchObject({
      code: 'SHOT_SET_CHARACTER_UNKNOWN',
    });
  });

  it('条件—场景不在冻结 STORY_BIBLE—报 SHOT_SET_SCENE_UNKNOWN', () => {
    const documents = cloneDocuments(buildDocuments(2));
    nested(shotAt(documents, 1), 'content').scene_id = 'scene_ghost';

    expect(validateShotSetCollection(documents, storyBible)).toMatchObject({
      code: 'SHOT_SET_SCENE_UNKNOWN',
    });
  });

  it('条件—Σ 时长低于 30 或超过 180—报 SHOT_SET_DURATION_OUT_OF_RANGE', () => {
    const below = buildDocuments(2, {
      0: { target_duration_sec: 10 },
      1: { target_duration_sec: 10 },
    });
    expect(validateShotSetCollection(below, storyBible)).toMatchObject({
      code: 'SHOT_SET_DURATION_OUT_OF_RANGE',
    });

    const above = buildDocuments(16);
    expect(validateShotSetCollection(above, storyBible)).toMatchObject({
      code: 'SHOT_SET_DURATION_OUT_OF_RANGE',
    });
  });
});
