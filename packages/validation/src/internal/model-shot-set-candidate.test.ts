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

  // 2026-08-20 Qwen 漂移实录：spoken 非旁白镜头 speaker_id null 此前漏至 FINAL
  // 层不可修复终态整代失败；本组断言其落在可修复的候选层（单角色豁免→注入派生）。
  describe('spoken 非旁白 speaker_id 值校验', () => {
    const spokenShot = (overrides: {
      characterIds?: unknown;
      renderMode?: string;
      speakerId?: unknown;
    }): Record<string, unknown> => {
      const shot = creativeShot();
      const content = shot.content as Record<string, unknown>;
      const dialogue = shot.dialogue as Record<string, unknown>;
      content.character_ids = overrides.characterIds ?? ['char_lin'];
      dialogue.dialogue_render_mode = overrides.renderMode ?? 'WEAK_LIP_SYNC';
      dialogue.speaker_id = overrides.speakerId ?? null;
      return shot;
    };

    it('多角色镜头 speaker null/非 string/形态乱码—候选层违规且明细定位', () => {
      for (const speakerId of [null, 42, '乱码', '']) {
        const result = validateModelShotSetCandidate({
          data: { shots: [spokenShot({ characterIds: ['char_lin', 'char_su'], speakerId })] },
        });
        expect(result).toMatchObject({
          errorCode: 'CANDIDATE_DIALOGUE_SPEAKER_INVALID',
          ok: false,
        });
        expect(result.details).toContain('shots[0].dialogue.speaker_id');
      }
    });

    it('多角色镜头合法形态 speaker（WEAK/PRECISE）—通过', () => {
      for (const renderMode of ['WEAK_LIP_SYNC', 'PRECISE_LIP_SYNC']) {
        const result = validateModelShotSetCandidate({
          data: {
            shots: [
              spokenShot({
                characterIds: ['char_lin', 'char_su'],
                renderMode,
                speakerId: 'char_lin',
              }),
            ],
          },
        });
        expect(result).toEqual({ errorCode: null, ok: true });
      }
    });

    it('单角色镜头 speaker 空值/形态违规—豁免（注入层派生唯一角色）', () => {
      for (const speakerId of [null, 42, '乱码']) {
        const result = validateModelShotSetCandidate({
          data: { shots: [spokenShot({ characterIds: ['char_lin'], speakerId })] },
        });
        expect(result).toEqual({ errorCode: null, ok: true });
      }
    });

    it('character_ids 异形不豁免—空数组/多员/非 string 员均为候选层违规', () => {
      for (const characterIds of [[], ['char_lin', 'char_su'], ['char_lin', 5], 'char_lin']) {
        const result = validateModelShotSetCandidate({
          data: { shots: [spokenShot({ characterIds, speakerId: null })] },
        });
        expect(result.errorCode).toBe('CANDIDATE_DIALOGUE_SPEAKER_INVALID');
      }
    });

    it('非校验口径镜头—NARRATION_FIRST spoken、无台词、SUBTITLE_ONLY 不触发', () => {
      const narration = validateModelShotSetCandidate({
        data: {
          shots: [
            spokenShot({ characterIds: ['char_lin', 'char_su'], renderMode: 'NARRATION_FIRST' }),
          ],
        },
      });
      expect(narration).toEqual({ errorCode: null, ok: true });
      const silent = creativeShot();
      (silent.content as Record<string, unknown>).spoken_text = '';
      (silent.dialogue as Record<string, unknown>).dialogue_render_mode = 'WEAK_LIP_SYNC';
      (silent.dialogue as Record<string, unknown>).speaker_id = null;
      expect(validateModelShotSetCandidate({ data: { shots: [silent] } })).toEqual({
        errorCode: null,
        ok: true,
      });
      const subtitle = spokenShot({
        characterIds: ['char_lin', 'char_su'],
        renderMode: 'SUBTITLE_ONLY',
      });
      expect(validateModelShotSetCandidate({ data: { shots: [subtitle] } })).toEqual({
        errorCode: null,
        ok: true,
      });
    });
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
  target_duration_sec: 12,
});
