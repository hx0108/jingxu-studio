import { useEffect, useRef } from 'react';

interface ConfirmActionDialogProps {
  readonly action: 'delete' | 'restore' | null;
  readonly projectName: string;
  readonly pending: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export const ConfirmActionDialog = ({
  action,
  projectName,
  pending,
  onConfirm,
  onCancel,
}: ConfirmActionDialogProps) => {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (action !== null) cancelRef.current?.focus();
  }, [action]);
  if (action === null) return null;
  const deleting = action === 'delete';
  return (
    <div className="dialog-backdrop">
      <section
        aria-describedby="confirm-description"
        aria-labelledby="confirm-title"
        aria-modal="true"
        className="dialog-card"
        role="dialog"
      >
        <h2 id="confirm-title">{deleting ? '将项目移入回收站？' : '恢复这个项目？'}</h2>
        <p id="confirm-description">
          {deleting
            ? `“${projectName}”会从活动列表移入回收站，本地项目目录、创作内容和 FormatProfile 历史不会被删除。此操作不会删除 Provider 侧数据。`
            : `“${projectName}”会返回活动列表；若名称已被占用，恢复将被阻止且不会产生部分写入。`}
        </p>
        <div className="dialog-actions">
          <button
            className={deleting ? 'danger-button' : undefined}
            disabled={pending}
            onClick={onConfirm}
            type="button"
          >
            {pending ? '正在处理…' : deleting ? '确认移入回收站' : '确认恢复'}
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
