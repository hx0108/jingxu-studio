import { useState } from 'react';

/**
 * storyboard-export D5：Σ 软带偏离确认对话（EXPORT_DURATION_DEVIATION 后弹出）。
 * 展示实际 Σ，用户填写偏离原因并确认后以同命令携带 warnConfirmed 重发。
 * 由父层条件挂载（每次导出弹层都是全新状态，无需 effect 重置）。
 */
export interface ExportDeviationDialogProps {
  readonly onConfirm: (deviationReason: string) => void;
  readonly onCancel: () => void;
  readonly open: boolean;
  readonly pending: boolean;
  readonly totalDurationSec: string;
}

export const ExportDeviationDialog = ({
  onConfirm,
  onCancel,
  open,
  pending,
  totalDurationSec,
}: ExportDeviationDialogProps) => {
  const [reason, setReason] = useState('');
  if (!open) return null;
  const trimmed = reason.trim();
  return (
    <div className="dialog-backdrop">
      <section
        aria-describedby="export-deviation-description"
        aria-labelledby="export-deviation-title"
        aria-modal="true"
        className="dialog-card"
        role="dialog"
      >
        <h2 id="export-deviation-title">整集时长偏离目标区间</h2>
        <p id="export-deviation-description">
          当前镜头时长合计 {totalDurationSec}s，偏离 60–120
          秒目标区间。确认偏离并填写原因后方可导出，原因将随导出留痕记录。
        </p>
        <label htmlFor="export-deviation-reason">偏离原因（必填）</label>
        <textarea
          autoFocus
          id="export-deviation-reason"
          maxLength={280}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          placeholder="例如：快闪节奏整集、双镜头极简叙事"
          value={reason}
        />
        <div className="dialog-actions">
          <button
            disabled={pending || trimmed === ''}
            name="export-deviation-confirm"
            onClick={() => {
              onConfirm(trimmed);
            }}
            type="button"
          >
            确认偏离并导出
          </button>
          <button
            className="secondary-button"
            disabled={pending}
            onClick={() => {
              onCancel();
            }}
            type="button"
          >
            取消导出
          </button>
        </div>
      </section>
    </div>
  );
};
