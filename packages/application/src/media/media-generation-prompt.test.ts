import { describe, expect, it } from 'vitest';

import {
  buildFirstFramePrompt,
  computeGenerationInputHash,
  extractShotCreativeFields,
  resolveImageSize,
} from './media-generation-prompt';

/** 生成 ShotContract 1.1.0 形态的镜头文档（仅本模块消费的创意字段需要真实）。 */
const shotDocument = (overrides: Readonly<Record<string, unknown>> = {}): string =>
  JSON.stringify({
    cinematography: {
      camera_angle: 'LOW',
      composition: '人物居右，雨幕占左三分之二',
      focus: '人物面部与手中的伞',
      shot_size: 'MEDIUM',
    },
    content: {
      action: '少女撑伞缓步走过雨巷',
      character_ids: ['char_hero'],
      emotion: '忧郁而克制',
      scene_id: 'scene_alley',
      spoken_text: '',
    },
    continuity: {
      continuity_mode: 'SCENE_CHANGE',
      first_frame_requirement: '雨幕中的巷口，少女半身入画',
    },
    generation_constraints: {
      image_prompt: '雨巷中的少女，中景，电影感',
      negative_constraints: ['文字水印', '多余人物'],
    },
    ...overrides,
  });

describe('extractShotCreativeFields', () => {
  it('解析创意字段—非法 JSON 或缺必需节返回 null', () => {
    const fields = extractShotCreativeFields(shotDocument());
    expect(fields).toMatchObject({
      action: '少女撑伞缓步走过雨巷',
      cameraAngle: 'LOW',
      characterIds: ['char_hero'],
      continuityMode: 'SCENE_CHANGE',
      firstFrameRequirement: '雨幕中的巷口，少女半身入画',
      imagePrompt: '雨巷中的少女，中景，电影感',
      negativeConstraints: ['文字水印', '多余人物'],
      sceneId: 'scene_alley',
      shotSize: 'MEDIUM',
    });
    expect(extractShotCreativeFields('not json')).toBeNull();
    expect(extractShotCreativeFields('123')).toBeNull();
    expect(extractShotCreativeFields(JSON.stringify({ content: {} }))).toBeNull();
  });
});

describe('resolveImageSize', () => {
  it('画幅映射五种合法值—未知画幅返回 null', () => {
    expect(resolveImageSize('16:9')).toEqual({ height: 1440, width: 2560 });
    expect(resolveImageSize('9:16')).toEqual({ height: 2560, width: 1440 });
    expect(resolveImageSize('1:1')).toEqual({ height: 2048, width: 2048 });
    expect(resolveImageSize('4:3')).toEqual({ height: 1728, width: 2304 });
    expect(resolveImageSize('3:4')).toEqual({ height: 2304, width: 1728 });
    expect(resolveImageSize('21:9')).toBeNull();
  });
});

describe('buildFirstFramePrompt', () => {
  it('image_prompt 为主描述—场景人物机位首帧要求拼接—含避免项', () => {
    const creative = extractShotCreativeFields(shotDocument());
    if (creative === null) throw new Error('镜头创意字段应可解析');
    const prompt = buildFirstFramePrompt({
      boundCharacters: [{ appearance: '16 岁少女，白裙，长发', name: '小雨' }],
      creative,
      scene: { description: '江南雨巷，青石板路与两侧老墙', name: '雨巷' },
    });
    expect(prompt).toBe(
      [
        '雨巷中的少女，中景，电影感',
        '场景：雨巷——江南雨巷，青石板路与两侧老墙',
        '人物：小雨（16 岁少女，白裙，长发）',
        '机位：MEDIUM / LOW；构图：人物居右，雨幕占左三分之二；焦点：人物面部与手中的伞',
        '首帧要求：雨幕中的巷口，少女半身入画',
        '避免：文字水印、多余人物',
      ].join('\n'),
    );
  });

  it('image_prompt 缺失时回退 action/emotion 复合—SAME_SCENE_CUT 附加同场景机位规则', () => {
    const document = shotDocument({
      cinematography: { shot_size: 'CLOSE_UP', camera_angle: 'EYE_LEVEL' },
      continuity: { continuity_mode: 'SAME_SCENE_CUT', first_frame_requirement: null },
      generation_constraints: {},
    });
    const creative = extractShotCreativeFields(document);
    if (creative === null) throw new Error('镜头创意字段应可解析');
    const prompt = buildFirstFramePrompt({ boundCharacters: [], creative, scene: null });
    expect(prompt).toBe(
      [
        '少女撑伞缓步走过雨巷，忧郁而克制',
        '机位：CLOSE_UP / EYE_LEVEL',
        '本镜头与前一镜头为同场景切镜：保持人物、服装与场景外观一致，仅按上述机位切换取景。',
      ].join('\n'),
    );
  });
});

describe('computeGenerationInputHash', () => {
  it('绑定列表顺序不影响哈希—任一输入变化即变化', () => {
    const hashPayload = (value: Readonly<Record<string, unknown>>): string => JSON.stringify(value);
    const base = {
      boundAssetVersionIds: ['v_b', 'v_a'],
      modelId: 'doubao-seedream-5-0-lite-260128',
      parametersFingerprint: 'seedream-v1/2560x1440',
      shotContentHash: 'c'.repeat(64),
      shotVersionId: 'scv_1',
    };
    const sorted = computeGenerationInputHash(base, hashPayload);
    expect(
      computeGenerationInputHash({ ...base, boundAssetVersionIds: ['v_a', 'v_b'] }, hashPayload),
    ).toBe(sorted);
    expect(
      computeGenerationInputHash({ ...base, boundAssetVersionIds: ['v_a', 'v_c'] }, hashPayload),
    ).not.toBe(sorted);
    expect(
      computeGenerationInputHash({ ...base, modelId: 'doubao-seedream-4-0-250828' }, hashPayload),
    ).not.toBe(sorted);
    expect(
      computeGenerationInputHash(
        { ...base, parametersFingerprint: 'seedream-v1/1440x2560' },
        hashPayload,
      ),
    ).not.toBe(sorted);
    expect(
      computeGenerationInputHash({ ...base, shotContentHash: 'd'.repeat(64) }, hashPayload),
    ).not.toBe(sorted);
    expect(computeGenerationInputHash({ ...base, shotVersionId: 'scv_2' }, hashPayload)).not.toBe(
      sorted,
    );
  });
});
