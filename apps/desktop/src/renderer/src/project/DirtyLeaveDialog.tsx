import { useEffect, useRef } from 'react';

export interface DirtyLeaveDialogProps {
  readonly open: boolean;
  readonly pending: boolean;
  readonly onSaveAndLeave: () => void;
  readonly onDiscard: () => void;
  readonly onCancel: () => void;
}

export const DirtyLeaveDialog = ({
  open,
  pending,
  onSaveAndLeave,
  onDiscard,
  onCancel,
}: DirtyLeaveDialogProps) => {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <div className="dialog-backdrop">
      <section
        aria-describedby="dirty-description"
        aria-labelledby="dirty-title"
        aria-modal="true"
        className="dialog-card"
        role="dialog"
      >
        <h2 id="dirty-title">创作设定尚未保存</h2>
        <p id="dirty-description">离开会影响当前表单。请选择如何处理这些修改。</p>
        <div className="dialog-actions">
          <button disabled={pending} onClick={onSaveAndLeave} type="button">
            保存并离开
          </button>
          <button className="danger-button" disabled={pending} onClick={onDiscard} type="button">
            放弃修改
          </button>
          <button
            autoFocus
            className="secondary-button"
            disabled={pending}
            onClick={onCancel}
            ref={cancelRef}
            type="button"
          >
            取消
          </button>
        </div>
      </section>
    </div>
  );
};
