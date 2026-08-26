import { describe, expect, it } from 'vitest';

import {
  VOICE_ALIGNED_TOLERANCE_MS,
  VOICE_ALIGNED_TOLERANCE_RATIO,
  VOICE_ALIGNMENT_RULES_VERSION,
  alignVoiceToShot,
} from './voice-alignment';

describe('voice-alignment 对齐引擎（PRD v1.4 §10.7.1 全表）', () => {
  it('音频基本相等—直接合成且无延展', () => {
    const result = alignVoiceToShot({
      audioDurationMs: 5000,
      manualOverride: null,
      shotDurationMs: 5000,
    });
    expect(result.category).toBe('ALIGNED');
    expect(result.strategy).toBe('DIRECT_MIX');
    expect(result.extendedMs).toBe(0);
    expect(result.dialogueComplete).toBe(true);
    expect(result.storyboardFallback).toBe(false);
  });

  it('偏差恰在容差边界—仍判基本相等（含绝对与相对容差较大者）', () => {
    const shotDurationMs = 4000;
    const tolerance = Math.max(
      VOICE_ALIGNED_TOLERANCE_MS,
      shotDurationMs * VOICE_ALIGNED_TOLERANCE_RATIO,
    );
    const atEdge = alignVoiceToShot({
      audioDurationMs: shotDurationMs + tolerance,
      manualOverride: null,
      shotDurationMs,
    });
    expect(atEdge.category).toBe('ALIGNED');
    const beyondEdge = alignVoiceToShot({
      audioDurationMs: shotDurationMs + tolerance + 1,
      manualOverride: null,
      shotDurationMs,
    });
    expect(beyondEdge.category).toBe('SLIGHTLY_LONG');
  });

  it('音频略长于镜头—默认静帧延展并记录延展毫秒', () => {
    const result = alignVoiceToShot({
      audioDurationMs: 6000,
      manualOverride: null,
      shotDurationMs: 5000,
    });
    expect(result.category).toBe('SLIGHTLY_LONG');
    expect(result.strategy).toBe('FREEZE_EXTEND');
    expect(result.extendedMs).toBe(1000);
    expect(result.dialogueComplete).toBe(true);
  });

  it('音频略长人工裁剪尾部—对白标记不完整', () => {
    const result = alignVoiceToShot({
      audioDurationMs: 6000,
      manualOverride: 'TRIM_AUDIO',
      shotDurationMs: 5000,
    });
    expect(result.strategy).toBe('MANUAL_TRIM_AUDIO');
    expect(result.dialogueComplete).toBe(false);
    expect(result.extendedMs).toBe(0);
  });

  it('音频远长于镜头—默认阻断并触发分镜层回退', () => {
    const result = alignVoiceToShot({
      audioDurationMs: 10000,
      manualOverride: null,
      shotDurationMs: 4000,
    });
    expect(result.category).toBe('FAR_LONG');
    expect(result.strategy).toBe('BLOCK_STORYBOARD_FALLBACK');
    expect(result.storyboardFallback).toBe(true);
    expect(result.dialogueComplete).toBe(true);
  });

  it('音频远长人工强制裁剪—标记对白不完整且不触发回退', () => {
    const result = alignVoiceToShot({
      audioDurationMs: 10000,
      manualOverride: 'FORCE_TRIM',
      shotDurationMs: 4000,
    });
    expect(result.strategy).toBe('FORCE_TRIM_DIALOGUE_INCOMPLETE');
    expect(result.dialogueComplete).toBe(false);
    expect(result.storyboardFallback).toBe(false);
  });

  it('音频短于镜头—默认尾部静音', () => {
    const result = alignVoiceToShot({
      audioDurationMs: 3000,
      manualOverride: null,
      shotDurationMs: 5000,
    });
    expect(result.category).toBe('SHORTER');
    expect(result.strategy).toBe('TAIL_SILENCE');
    expect(result.dialogueComplete).toBe(true);
  });

  it('音频短于镜头人工提前切入—策略切换且对白完整', () => {
    const result = alignVoiceToShot({
      audioDurationMs: 3000,
      manualOverride: 'EARLY_CUT_NEXT',
      shotDurationMs: 5000,
    });
    expect(result.strategy).toBe('EARLY_CUT_NEXT');
    expect(result.dialogueComplete).toBe(true);
  });

  it('分类确定性—同输入同输出且规则版本随结果输出', () => {
    const input = { audioDurationMs: 5200, manualOverride: null, shotDurationMs: 5000 } as const;
    const first = alignVoiceToShot({ ...input });
    const second = alignVoiceToShot({ ...input });
    expect(first).toEqual(second);
    expect(first.rulesVersion).toBe(VOICE_ALIGNMENT_RULES_VERSION);
  });

  it('远长阈值相对取大—长镜头按比例判定而非绝对毫秒', () => {
    // 镜头 10s：远长阈值 = max(2000, 5000) = 5000ms；音频 14s 偏差 4000ms 仍属略长。
    const stillSlight = alignVoiceToShot({
      audioDurationMs: 14000,
      manualOverride: null,
      shotDurationMs: 10000,
    });
    expect(stillSlight.category).toBe('SLIGHTLY_LONG');
    const farLong = alignVoiceToShot({
      audioDurationMs: 15001,
      manualOverride: null,
      shotDurationMs: 10000,
    });
    expect(farLong.category).toBe('FAR_LONG');
  });

  it('非法输入—非正整数时长抛错', () => {
    expect(() =>
      alignVoiceToShot({ audioDurationMs: 0, manualOverride: null, shotDurationMs: 5000 }),
    ).toThrow(/VOICE_ALIGNMENT_INPUT_INVALID/u);
    expect(() =>
      alignVoiceToShot({ audioDurationMs: 3200.5, manualOverride: null, shotDurationMs: 5000 }),
    ).toThrow(/VOICE_ALIGNMENT_INPUT_INVALID/u);
  });

  it('覆盖与类别错配—显式抛错而非静默回退', () => {
    expect(() =>
      alignVoiceToShot({
        audioDurationMs: 5000,
        manualOverride: 'TRIM_AUDIO',
        shotDurationMs: 5000,
      }),
    ).toThrow(/OVERRIDE_INVALID/u);
    expect(() =>
      alignVoiceToShot({
        audioDurationMs: 3000,
        manualOverride: 'FORCE_TRIM',
        shotDurationMs: 5000,
      }),
    ).toThrow(/OVERRIDE_INVALID/u);
    expect(() =>
      alignVoiceToShot({
        audioDurationMs: 6000,
        manualOverride: 'EARLY_CUT_NEXT',
        shotDurationMs: 5000,
      }),
    ).toThrow(/OVERRIDE_INVALID/u);
    expect(() =>
      alignVoiceToShot({
        audioDurationMs: 10000,
        manualOverride: 'EARLY_CUT_NEXT',
        shotDurationMs: 4000,
      }),
    ).toThrow(/OVERRIDE_INVALID/u);
  });
});
