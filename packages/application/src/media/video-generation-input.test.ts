import { describe, expect, it } from 'vitest';

import {
  buildVideoParametersFingerprint,
  buildVideoPrompt,
  computeVideoGenerationInputHash,
  extractVideoShotFields,
  resolveVideoDurationTier,
} from './video-generation-input';

/** 注入哈希替身（沿 media-generation-service.test 先例）：透传 canonical JSON 锁键序/字段集。 */
const hashPayloadOf = (value: Readonly<Record<string, unknown>>): string =>
  `sha256:${JSON.stringify(value)}`;

const FIRST_FRAME_SHA256 = '0123456789abcdef'.repeat(4);
const MODEL_ID = 'doubao-seedance-1-0-lite-i2v-250428';
const FINGERPRINT = 'seedance-v1:doubao-seedance-1-0-lite-i2v-250428:1080x1920:10:0123456789ab';

describe('video-generation-input 纯函数（金样锁形）', () => {
  it('参数指纹—seedance-v1 形态：modelId:WxH:duration:首帧 sha 前 12 位', () => {
    expect(
      buildVideoParametersFingerprint({
        durationSec: 10,
        firstFrameFileSha256: FIRST_FRAME_SHA256,
        modelId: MODEL_ID,
        size: { height: 1920, width: 1080 },
      }),
    ).toBe(FINGERPRINT);
    // 任一维度变化都改变指纹（世代判定的根基）。
    expect(
      buildVideoParametersFingerprint({
        durationSec: 5,
        firstFrameFileSha256: FIRST_FRAME_SHA256,
        modelId: MODEL_ID,
        size: { height: 1920, width: 1080 },
      }),
    ).not.toBe(FINGERPRINT);
    expect(
      buildVideoParametersFingerprint({
        durationSec: 10,
        firstFrameFileSha256: 'fedcba9876543210'.repeat(4),
        modelId: MODEL_ID,
        size: { height: 1920, width: 1080 },
      }),
    ).not.toBe(FINGERPRINT);
  });

  it('generationInputHash—canonical JSON 字母序键+不含资产绑定（金样锁形）', () => {
    const descriptor = {
      firstFrameFileSha256: FIRST_FRAME_SHA256,
      modelId: MODEL_ID,
      parametersFingerprint: FINGERPRINT,
      shotContentHash: 'c'.repeat(64),
      shotVersionId: 'scv_0001',
    };
    // 金样：字段集/键序/取值任一漂移都会偏离此串（真实 sha256 由组合根 createHash
    // 承载；本形态的 sha256 参考摘要 c56fe5e0cfafbbb40aeb0173d540719066d48fab912f4566bf207d41fe77fdb7）。
    expect(computeVideoGenerationInputHash(descriptor, hashPayloadOf)).toBe(
      `sha256:${JSON.stringify({
        firstFrameFileSha256: FIRST_FRAME_SHA256,
        modelId: MODEL_ID,
        parametersFingerprint: FINGERPRINT,
        shotContentHash: 'c'.repeat(64),
        shotVersionId: 'scv_0001',
      })}`,
    );
    // 镜头版本或内容哈希变化 → 新世代。
    expect(
      computeVideoGenerationInputHash({ ...descriptor, shotVersionId: 'scv_0002' }, hashPayloadOf),
    ).not.toBe(
      `sha256:${JSON.stringify({
        firstFrameFileSha256: FIRST_FRAME_SHA256,
        modelId: MODEL_ID,
        parametersFingerprint: FINGERPRINT,
        shotContentHash: 'c'.repeat(64),
        shotVersionId: 'scv_0001',
      })}`,
    );
  });

  it('时长档位—最小档 ≥ target；超上限压最大档并如实标注；快照非法抛稳定错误', () => {
    const range = { maxSec: 10, minSec: 5 };
    expect(resolveVideoDurationTier(3, range)).toEqual({ durationSec: 5, exceededMax: false });
    expect(resolveVideoDurationTier(5, range)).toEqual({ durationSec: 5, exceededMax: false });
    expect(resolveVideoDurationTier(7, range)).toEqual({ durationSec: 7, exceededMax: false });
    expect(resolveVideoDurationTier(6.5, range)).toEqual({ durationSec: 7, exceededMax: false });
    expect(resolveVideoDurationTier(10, range)).toEqual({ durationSec: 10, exceededMax: false });
    expect(resolveVideoDurationTier(12, range)).toEqual({ durationSec: 10, exceededMax: true });
    expect(resolveVideoDurationTier(20, range)).toEqual({ durationSec: 10, exceededMax: true });
    for (const bad of [
      { maxSec: 4, minSec: 5 },
      { maxSec: 10, minSec: 0 },
      { maxSec: 10.5, minSec: 5 },
    ]) {
      expect(() => resolveVideoDurationTier(7, bad), JSON.stringify(bad)).toThrow(
        'VIDEO_DURATION_RANGE_INVALID',
      );
    }
  });

  it('镜头文档视频字段提取—合法文档四字段；损坏/缺节返回 null', () => {
    const document = JSON.stringify({
      cinematography: { camera_angle: 'EYE_LEVEL', camera_motion: 'DOLLY', shot_size: 'MEDIUM' },
      content: { action: '少女撑伞走过雨巷', character_ids: [], emotion: '怅惘', scene_id: null },
      continuity: { continuity_mode: 'SCENE_CHANGE' },
      generation_constraints: { image_prompt: '雨巷中的少女' },
      narrative_purpose: '建立雨巷氛围',
    });
    expect(extractVideoShotFields(document)).toEqual({
      action: '少女撑伞走过雨巷',
      cameraMotion: 'DOLLY',
      emotion: '怅惘',
      narrativePurpose: '建立雨巷氛围',
    });
    // 图片提示词字段（image_prompt 等）不进入视频字段——i2v 输入=首帧+动态描述。
    expect(extractVideoShotFields('{bad json')).toBeNull();
    expect(extractVideoShotFields(JSON.stringify({ content: { action: '走' } }))).toBeNull();
    expect(
      extractVideoShotFields(JSON.stringify({ cinematography: { camera_motion: 'PAN' } })),
    ).toBeNull();
  });

  it('视频提示词金样—action/emotion 复合 + 叙事目的 + 运镜文本；可缺项', () => {
    expect(
      buildVideoPrompt({
        action: '少女撑伞走过雨巷',
        cameraMotion: 'DOLLY',
        emotion: '怅惘',
        narrativePurpose: '建立雨巷氛围',
      }),
    ).toBe('少女撑伞走过雨巷，怅惘\n叙事目的：建立雨巷氛围\n运镜：推轨');
    // 运镜枚举逐项映射；未知枚举按缺失处理（不崩、不输出原文）。
    expect(
      buildVideoPrompt({
        action: null,
        cameraMotion: 'STATIC',
        emotion: null,
        narrativePurpose: null,
      }),
    ).toBe('运镜：固定机位');
    expect(
      buildVideoPrompt({
        action: null,
        cameraMotion: 'ORBIT',
        emotion: null,
        narrativePurpose: null,
      }),
    ).toBe('');
    // 全缺失 → 空串（由上层决定是否门禁，本层不臆造内容）。
    expect(
      buildVideoPrompt({ action: null, cameraMotion: null, emotion: null, narrativePurpose: null }),
    ).toBe('');
  });
});
