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

export const VALID_MODEL_SHOT_SET_CANDIDATE_FIXTURES: Readonly<Record<string, unknown>> = {
  单镜头完整创意: { data: { shots: [creativeShot()] } },
  多镜头完整创意: {
    data: { shots: [creativeShot(), creativeShot(), creativeShot()] },
  },
};

export const INVALID_MODEL_SHOT_SET_CANDIDATE_FIXTURES: Readonly<Record<string, unknown>> = {
  数组候选: [{ data: { shots: [creativeShot()] } }],
  信封混入系统字段: { data: { shots: [creativeShot()] }, stage: 'SHOT_CONTRACT' },
  'data 非对象': { data: 'shots' },
  'shots 缺失': { data: {} },
  'shots 非数组': { data: { shots: 'many' } },
  'shots 空数组': { data: { shots: [] } },
  镜头为字符串: { data: { shots: ['shot-1'] } },
  缺少平铺创意键: {
    data: {
      shots: [
        (() => {
          const shot = creativeShot();
          delete shot.narrative_purpose;
          return shot;
        })(),
      ],
    },
  },
  缺少分组: {
    data: {
      shots: [
        (() => {
          const shot = creativeShot();
          delete shot.cinematography;
          return shot;
        })(),
      ],
    },
  },
  分组缺键: {
    data: {
      shots: [
        (() => {
          const shot = creativeShot();
          delete (shot.cinematography as Record<string, unknown>).shot_size;
          return shot;
        })(),
      ],
    },
  },
  缺少时长字段: {
    data: {
      shots: [
        (() => {
          const shot = creativeShot();
          delete shot.target_duration_sec;
          return shot;
        })(),
      ],
    },
  },
};
