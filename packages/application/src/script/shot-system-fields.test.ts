import { describe, expect, it } from 'vitest';

import { deriveDialogueFlags, injectShotSystemFields } from './shot-system-fields';

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

const context = {
  formatProfileId: 'format-0001',
  invocationId: 'inv-0001',
  newShotId: (index: number) => `shot_gen_${String(index + 1)}`,
  newVersionId: (index: number) => `scv_gen_${String(index + 1)}_v1`,
};

describe('deriveDialogueFlags', () => {
  it.each([
    ['NARRATION_FIRST', '有台词', true, false],
    ['NARRATION_FIRST', '', false, false],
    ['WEAK_LIP_SYNC', '有台词', true, false],
    ['WEAK_LIP_SYNC', '', false, false],
    ['PRECISE_LIP_SYNC', '有台词', true, true],
    ['PRECISE_LIP_SYNC', '', false, false],
    ['SUBTITLE_ONLY', '有台词', false, false],
    ['SUBTITLE_ONLY', '', false, false],
  ] as const)(
    '条件—%s 且台词%s—audio=%s lip_sync=%s 与 Schema 精确值一致',
    (mode, spoken, audio, lip) => {
      expect(
        deriveDialogueFlags({ renderMode: mode, spokenText: spoken === '' ? '' : '台词' }),
      ).toEqual({ audioRequired: audio, lipSyncRequired: lip });
    },
  );

  it('条件—渲染模式未知—返回 null 交由调用方判失败', () => {
    expect(deriveDialogueFlags({ renderMode: 'MIME', spokenText: '台词' })).toBeNull();
  });
});

describe('injectShotSystemFields', () => {
  it('条件—两镜头候选—注入标识、版本、溯源与派生常量且 sequence 连续', () => {
    const documents = injectShotSystemFields(
      { data: { shots: [creativeShot(), creativeShot()] } },
      context,
    );

    expect(documents).toHaveLength(2);
    expect(documents[0]).toMatchObject({
      contract_version: 1,
      derived_from_shot_ids: [],
      format_profile_id: 'format-0001',
      locked_paths: [],
      narrative_purpose: '建立氛围',
      parent_version_id: null,
      provenance: {
        last_edit_source: 'AI',
        source_invocation_id: 'inv-0001',
        source_type: 'AI_GENERATED',
      },
      schema_version: '1.1.0',
      sequence: 1,
      shot_id: 'shot_gen_1',
      status: 'DRAFT',
      target_duration_sec: 12,
      version_id: 'scv_gen_1_v1',
    });
    expect(documents[1]).toMatchObject({ sequence: 2, shot_id: 'shot_gen_2' });
    expect(documents[0]?.dialogue).toMatchObject({
      audio_required: true,
      dialogue_mode_source: 'PROJECT_DEFAULT',
      lip_sync_required: false,
      override_reason: null,
      speaker_id: 'narrator',
    });
    expect(documents[0]?.acceptance).toMatchObject({ human_review_required: true });
    expect(documents[0]?.continuity).toMatchObject({ asset_version_ids: [] });
    expect(documents[0]?.generation_constraints).toMatchObject({
      budget_estimate: {
        currency_or_credit: 'UNKNOWN',
        is_estimate: true,
        max: null,
        min: null,
        price_version: null,
      },
    });
  });

  it('条件—模型输出伪造系统字段与多余键—全部丢弃并以注入值为准', () => {
    const documents = injectShotSystemFields(
      {
        data: {
          shots: [
            creativeShot({
              junk_field: '多余',
              schema_version: '9.9.9',
              shot_id: 'shot_forged',
              status: 'READY',
            }),
          ],
        },
      },
      context,
    );

    // 多余键整体丢弃（显式挑键），系统字段以注入值为准。
    expect(documents[0]).not.toHaveProperty('junk_field');
    expect(documents[0]).toMatchObject({
      schema_version: '1.1.0',
      shot_id: 'shot_gen_1',
      status: 'DRAFT',
    });
  });

  it('条件—NARRATION_FIRST 且有台词—模型误填角色说话人被系统改写为 narrator', () => {
    const shot = creativeShot();
    (shot.dialogue as Record<string, unknown>).speaker_id = 'char_lin';

    const documents = injectShotSystemFields({ data: { shots: [shot] } }, context);
    const dialogue = documents[0]?.dialogue as Record<string, unknown> | undefined;

    expect(dialogue?.speaker_id).toBe('narrator');
  });

  it('条件—无台词（spoken_text 为空）—speaker_id 恒 null、时长恒 0，模型非空值被丢弃', () => {
    // 真实 Qwen 联调缺陷回归钉：无台词镜头模型给出非空 speaker/时长，被 FINAL 层
    // SCHEMA_VALIDATION_CONST/TYPE 拒绝（设计上属系统派生精确值，不应信任模型）。
    const spokenContent = creativeShot().content as Record<string, unknown>;
    const shot = creativeShot({
      content: { ...spokenContent, spoken_text: '' },
      dialogue: {
        dialogue_render_mode: 'NARRATION_FIRST',
        estimated_speech_duration_sec: 3,
        speaker_id: 'narrator',
      },
    });

    const documents = injectShotSystemFields({ data: { shots: [shot] } }, context);
    const dialogue = documents[0]?.dialogue as Record<string, unknown> | undefined;

    expect(dialogue).toMatchObject({
      audio_required: false,
      estimated_speech_duration_sec: 0,
      lip_sync_required: false,
      speaker_id: null,
    });
  });

  it('条件—工厂产生真实唯一 id（非 index 决定）—每镜头恰好调用一次且 previous_shot_id 引用真实 shot_id', () => {
    let shotIdCalls = 0;
    const uniqueIds = new Map<number, string>();
    const uniqueContext = {
      ...context,
      newShotId: (index: number) => {
        shotIdCalls += 1;
        const id = `shot_u${String(shotIdCalls)}`;
        uniqueIds.set(index, id);
        return id;
      },
    };

    const documents = injectShotSystemFields(
      {
        data: {
          shots: [
            creativeShot({
              continuity: {
                continuity_mode: 'CONTINUOUS_ACTION',
                first_frame_requirement: '',
                last_frame_requirement: '',
                previous_shot_id: null,
              },
            }),
            creativeShot({
              continuity: {
                continuity_mode: 'CONTINUOUS_ACTION',
                first_frame_requirement: '',
                last_frame_requirement: '',
                previous_shot_id: null,
              },
            }),
          ],
        },
      },
      uniqueContext,
    );

    // 每镜头恰好一次：shot_id 与 previous_shot_id 派生共用同一次调用结果。
    expect(shotIdCalls).toBe(2);
    expect(documents[0]).toMatchObject({ shot_id: uniqueIds.get(0) });
    expect(documents[1]).toMatchObject({ shot_id: uniqueIds.get(1) });
    expect(
      (documents[1]?.continuity as Record<string, unknown> | undefined)?.previous_shot_id,
    ).toBe(uniqueIds.get(0));
  });

  it('条件—previous_shot_id 系统派生—CONTINUOUS_ACTION 指向 sequence-1，模型输出值丢弃', () => {
    const first = creativeShot({
      continuity: {
        continuity_mode: 'CONTINUOUS_ACTION',
        first_frame_requirement: '',
        last_frame_requirement: '',
        previous_shot_id: 'shot_forged_by_model',
      },
    });
    const second = creativeShot({
      continuity: {
        continuity_mode: 'CONTINUOUS_ACTION',
        first_frame_requirement: '',
        last_frame_requirement: '',
        previous_shot_id: 'shot_forged',
      },
    });

    const documents = injectShotSystemFields({ data: { shots: [first, second] } }, context);

    // 首镜头无前置：派生 null（集合校验层负责报 CONTINUOUS_ACTION 需要前置镜头）。
    expect(
      (documents[0]?.continuity as Record<string, unknown> | undefined)?.previous_shot_id,
    ).toBeNull();
    expect(
      (documents[1]?.continuity as Record<string, unknown> | undefined)?.previous_shot_id,
    ).toBe('shot_gen_1');
  });

  it('条件—候选结构非法—防御性抛稳定错误', () => {
    expect(() => injectShotSystemFields('x', context)).toThrow('SHOT_CANDIDATE_NOT_OBJECT');
    expect(() => injectShotSystemFields({ data: { shots: [] } }, context)).toThrow(
      'SHOT_CANDIDATE_SHOTS_INVALID',
    );
    expect(() => injectShotSystemFields({ data: { shots: ['s'] } }, context)).toThrow(
      'SHOT_CANDIDATE_SHOT_INVALID',
    );
    expect(() =>
      injectShotSystemFields(
        { data: { shots: [creativeShot({ cinematography: undefined })] } },
        context,
      ),
    ).toThrow('SHOT_CANDIDATE_CREATIVE_FIELD_INVALID');
    expect(() =>
      injectShotSystemFields(
        { data: { shots: [creativeShot({ target_duration_sec: '长' })] } },
        context,
      ),
    ).toThrow('SHOT_CANDIDATE_CREATIVE_FIELD_INVALID');
    expect(() =>
      injectShotSystemFields({ data: { shots: [creativeShot({ dialogue: {} })] } }, context),
    ).toThrow('SHOT_DIALOGUE_MODE_INVALID');
  });
});
