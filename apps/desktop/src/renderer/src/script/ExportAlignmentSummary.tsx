import type { VideoTimelineAlignmentItemDto } from '@jingxu/contracts';

import { ALIGNMENT_CATEGORY_LABELS, ALIGNMENT_STRATEGY_LABELS } from './video-timeline-ui';

/**
 * 导出面板的对齐摘要（v2 §7.3）：逐镜头冻结记录的
 * 分类/策略/规则版本/四要素与延展毫秒如实展示；未知枚举原码直出。
 */
export const ExportAlignmentSummary = ({
  alignmentItems,
}: {
  readonly alignmentItems: readonly VideoTimelineAlignmentItemDto[];
}) => {
  if (alignmentItems.length === 0) return null;
  return (
    <div aria-label="对齐摘要">
      <p className="action-hint">冻结对齐记录（随时间线版本固化）：</p>
      <ol className="shot-card-list">
        {alignmentItems.map((row) => (
          <li key={row.shotId}>
            <div className="shot-card">
              <span>{row.shotId}</span>
              <span>
                {ALIGNMENT_CATEGORY_LABELS[row.category] ?? row.category} ·{' '}
                {ALIGNMENT_STRATEGY_LABELS[row.strategy] ?? row.strategy}
              </span>
              <span>
                配音 {String(row.audioDurationMs)} ms / 镜头 {String(row.shotDurationMs)} ms
                {row.extendedMs > 0 && `（末帧延展 ${String(row.extendedMs)} ms）`}
              </span>
              {row.manualOverride !== null && <span>人工覆盖：{row.manualOverride}</span>}
              {!row.dialogueComplete && <b>对白不完整</b>}
              {row.storyboardFallback && <b>已阻断导出：请回分镜层调整或选择强制裁剪</b>}
              <code>规则版本 {row.rulesVersion}</code>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
};
