import { describe, expect, it } from 'vitest';

import {
  INVALID_MODEL_SHOT_SET_CANDIDATE_FIXTURES,
  VALID_MODEL_SHOT_SET_CANDIDATE_FIXTURES,
} from './fixtures/model-shot-set-candidate';
import { validateModelShotSetCandidate } from './model-shot-set-candidate';

describe('ModelShotSetCandidate', () => {
  it.each(Object.entries(VALID_MODEL_SHOT_SET_CANDIDATE_FIXTURES))(
    '条件—%s 候选只含 data 与完整创意键—通过模型层契约',
    (_name, candidate) => {
      expect(validateModelShotSetCandidate(candidate)).toEqual({ errorCode: null, ok: true });
    },
  );

  it.each(Object.entries(INVALID_MODEL_SHOT_SET_CANDIDATE_FIXTURES))(
    '条件—%s 单一错误候选—严格拒绝',
    (_name, candidate) => {
      expect(validateModelShotSetCandidate(candidate).ok).toBe(false);
    },
  );

  it('条件—镜头缺失创意键—明细定位到 shots 下标与键路径', () => {
    const shot = creativeShot();
    delete (shot.cinematography as Record<string, unknown>).camera_motion;
    const result = validateModelShotSetCandidate({
      data: { shots: [{}, shot] },
    });

    expect(result).toMatchObject({ errorCode: 'CANDIDATE_DATA_INVALID', ok: false });
    expect(result.details).toContain('shots[0].narrative_purpose');
    expect(result.details).toContain('shots[1].cinematography.camera_motion');
  });

  it('条件—明细化不截断—截断职责归属候选契约管线', () => {
    const shots = Array.from({ length: 12 }, () => ({}));
    const result = validateModelShotSetCandidate({ data: { shots } });

    expect(result.ok).toBe(false);
    expect((result.details ?? []).length).toBeGreaterThan(10);
  });
});

const creativeShot = (): Record<string, unknown> => ({
  acceptance: { must_include: ['雨天街道'], must_not_include: [] },
  cinematography: {
    camera_angle: 'EYE_LEVEL',
    camera_motion: 'STATIC',
    composition: '中景双人构图',
    focus: '前景人物清晰',
    frontal_face: true,
    mouth_visible: true,
    shot_size: 'MEDIUM',
  },
  content: {
    action: '林然撑伞走过斑马线',
    character_ids: ['char_lin'],
    emotion: '焦虑',
    prop_ids: ['prop_umbrella'],
    scene_id: 'scene_street',
    spoken_text: '雨越下越大了。',
  },
  continuity: {
    continuity_mode: 'SCENE_CHANGE',
    first_frame_requirement: '雨夜街道全景',
    last_frame_requirement: '林然回望',
    previous_shot_id: null,
  },
  dialogue: {
    dialogue_render_mode: 'NARRATION_FIRST',
    estimated_speech_duration_sec: 2,
    speaker_id: 'narrator',
  },
  generation_constraints: {
    capability_requirements: [{ capability: 'FIRST_FRAME', required: true }],
    image_prompt: '雨夜霓虹街道，中景',
    negative_constraints: ['文字水印'],
    video_prompt: '人物撑伞缓行，镜头静止',
  },
  narrative_purpose: '建立雨夜氛围与主角状态',
});
