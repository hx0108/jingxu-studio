import { describe, expect, it } from 'vitest';

import { ASPECT_RATIOS, CREATION_MODES, DIALOGUE_RENDER_MODES } from '@jingxu/domain';
import { aspectRatioSchema, creationModeSchema, dialogueRenderModeSchema } from '@jingxu/contracts';

/**
 * Contract 自持枚举字面量（零 @jingxu/* 生产依赖）必须与 Domain 同名常量保持一致。
 * 本测试是跨包漂移检测：任一侧增删枚举值而另一侧未跟随时失败。
 */
describe('Contract 枚举与 Domain 对齐', () => {
  it('aspectRatioSchema 选项—成员集—等于 domain ASPECT_RATIOS', () => {
    expect(new Set(aspectRatioSchema.options)).toEqual(new Set(ASPECT_RATIOS));
  });

  it('creationModeSchema 选项—成员集—等于 domain CREATION_MODES', () => {
    expect(new Set(creationModeSchema.options)).toEqual(new Set(CREATION_MODES));
  });

  it('dialogueRenderModeSchema 选项—成员集—等于 domain DIALOGUE_RENDER_MODES', () => {
    expect(new Set(dialogueRenderModeSchema.options)).toEqual(new Set(DIALOGUE_RENDER_MODES));
  });
});
