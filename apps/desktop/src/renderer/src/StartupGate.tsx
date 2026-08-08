import type { StartupStatusDto } from '@jingxu/contracts';

export interface StartupGateProps {
  readonly onRestore: (backupId: string) => void;
  readonly onRetry: () => void;
  readonly pendingAction: boolean;
  readonly status: StartupStatusDto;
  readonly transportFailed?: boolean;
}

const ReadyWorkspace = () => (
  <main className="workspace-shell" data-testid="workspace-ready">
    <section className="status-card" aria-labelledby="workspace-title">
      <p className="eyebrow">JINGXU STUDIO</p>
      <h1 id="workspace-title">镜序 Studio V1 工程基线</h1>
      <p>本地数据库已通过启动检查。当前 Change 仅提供持久化运行时，不包含业务功能。</p>
    </section>
  </main>
);

export const StartupGate = ({
  onRestore,
  onRetry,
  pendingAction,
  status,
  transportFailed = false,
}: StartupGateProps) => {
  if (status.state === 'READY') return <ReadyWorkspace />;

  if (transportFailed) {
    return (
      <main className="workspace-shell fault-shell">
        <section className="status-card fault-card" role="alert">
          <p className="eyebrow">READ-ONLY STARTUP FAULT</p>
          <h1>无法读取启动状态</h1>
          <p className="error-code">RUNTIME_IPC_FAILED</p>
          <p>主进程未返回可验证的启动状态。请完全退出应用后重试。</p>
        </section>
      </main>
    );
  }

  if (status.state !== 'READ_ONLY_FAULT') {
    return (
      <main className="workspace-shell">
        <section className="status-card" aria-live="polite">
          <p className="eyebrow">STARTUP CHECK</p>
          <h1>正在检查本地数据库</h1>
          <p>当前阶段：{status.currentPhase ?? 'DATABASE_OPEN'}</p>
          <p>检查完成前不会开放写入或正常工作区。</p>
        </section>
      </main>
    );
  }

  const retryAllowed = status.allowedActions.includes('RETRY');
  const restoreAllowed = status.allowedActions.includes('RESTORE');
  return (
    <main className="workspace-shell fault-shell">
      <section className="status-card fault-card" aria-labelledby="fault-title">
        <p className="eyebrow">READ-ONLY STARTUP FAULT</p>
        <h1 id="fault-title">数据库只读故障</h1>
        <dl className="fault-details">
          <div>
            <dt>错误码</dt>
            <dd className="error-code">{status.errorCode ?? 'DATABASE_OPEN_FAILED'}</dd>
          </div>
          <div>
            <dt>检查阶段</dt>
            <dd>{status.currentPhase ?? 'DATABASE_OPEN'}</dd>
          </div>
        </dl>
        <p>{status.summary ?? '数据库启动检查未通过。'}</p>
        <div className="fault-actions">
          <button disabled={!retryAllowed || pendingAction} onClick={onRetry} type="button">
            {pendingAction ? '正在处理…' : '重新检查'}
          </button>
          {!retryAllowed && <p className="action-hint">当前故障不能直接重试。</p>}
        </div>
        <div className="backup-list">
          <h2>可用受管理备份</h2>
          {status.backups.length === 0 ? (
            <p>没有通过验证的备份，恢复操作不可用。</p>
          ) : (
            status.backups.map((backup) => (
              <article className="backup-card" key={backup.backupId}>
                <div>
                  <strong>{backup.summary}</strong>
                  <small>{new Date(backup.createdAt).toLocaleString('zh-CN')}</small>
                </div>
                <button
                  disabled={!restoreAllowed || pendingAction}
                  onClick={() => {
                    onRestore(backup.backupId);
                  }}
                  type="button"
                >
                  从此备份恢复
                </button>
              </article>
            ))
          )}
        </div>
      </section>
    </main>
  );
};
