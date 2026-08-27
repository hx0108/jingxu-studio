import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { VideoTimelineAlignmentItemDto } from '@jingxu/contracts';

import { ExportAlignmentSummary } from './ExportAlignmentSummary';

const row = (overrides: Record<string, unknown> = {}): VideoTimelineAlignmentItemDto => ({
  audioDurationMs: 1_500,
  category: 'SLIGHTLY_LONG',
  dialogueComplete: true,
  extendedMs: 500,
  manualOverride: null,
  rulesVersion: 'voice-alignment-rules-v1',
  shotDurationMs: 1_000,
  shotId: 'shot_00000001',
  storyboardFallback: false,
  strategy: 'FREEZE_EXTEND',
  ...overrides,
});

describe('ExportAlignmentSummary', () => {
  it('空记录—不渲染任何摘要', () => {
    const html = renderToStaticMarkup(<ExportAlignmentSummary alignmentItems={[]} />);
    expect(html).toBe('');
  });

  it('冻结行—分类/策略中文标签、四要素与延展毫秒如实展示且无路径', () => {
    const html = renderToStaticMarkup(<ExportAlignmentSummary alignmentItems={[row()]} />);
    expect(html).toContain('对齐摘要');
    expect(html).toContain('略长于镜头 · 末帧延展');
    expect(html).toContain('配音 1500 ms / 镜头 1000 ms');
    expect(html).toContain('（末帧延展 500 ms）');
    expect(html).toContain('规则版本 voice-alignment-rules-v1');
    // 延展为 0 时不再复述“末帧延展”数值段。
    expect(html).not.toContain('人工覆盖');
    expect(html).not.toContain('对白不完整');
    expect(html).not.toContain('C:');
    expect(html).not.toContain('--');
  });

  it('回退阻断与强制裁剪—给出阻断文案与不完整标记', () => {
    const blocked = renderToStaticMarkup(
      <ExportAlignmentSummary
        alignmentItems={[
          row({
            category: 'FAR_LONG',
            extendedMs: 0,
            strategy: 'BLOCK_STORYBOARD_FALLBACK',
            storyboardFallback: true,
          }),
        ]}
      />,
    );
    expect(blocked).toContain('远长于镜头 · 分镜层回退（阻断导出）');
    expect(blocked).toContain('已阻断导出：请回分镜层调整或选择强制裁剪');

    const forced = renderToStaticMarkup(
      <ExportAlignmentSummary
        alignmentItems={[
          row({
            category: 'FAR_LONG',
            dialogueComplete: false,
            extendedMs: 0,
            manualOverride: 'FORCE_TRIM',
            strategy: 'FORCE_TRIM_DIALOGUE_INCOMPLETE',
            storyboardFallback: false,
          }),
        ]}
      />,
    );
    expect(forced).toContain('对白不完整');
    expect(forced).toContain('强制裁剪（对白不完整）');
    expect(forced).toContain('人工覆盖：FORCE_TRIM');
  });

  it('未知枚举—原码直出不猜测语义', () => {
    const html = renderToStaticMarkup(
      <ExportAlignmentSummary
        alignmentItems={[row({ category: 'MYSTERY_CATEGORY', strategy: 'MYSTERY_STRATEGY' })]}
      />,
    );
    expect(html).toContain('MYSTERY_CATEGORY · MYSTERY_STRATEGY');
  });
});
