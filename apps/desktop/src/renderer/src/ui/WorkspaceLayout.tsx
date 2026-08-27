import { useState, type ReactNode } from 'react';

import { workspaceStatusLabel, workspaceStatusTone } from './workspace-status';

export const StatusBadge = ({ status }: { readonly status: string | null | undefined }) => (
  <span className={`status-pill status-pill-${workspaceStatusTone(status)}`}>
    <span aria-hidden="true" className="status-dot" />
    {workspaceStatusLabel(status)}
  </span>
);

export interface WorkspaceLayoutProps {
  readonly flow: ReactNode;
  readonly children: ReactNode;
  readonly inspector?: ReactNode;
  readonly inspectorLabel?: string;
}

export const WorkspaceLayout = ({
  flow,
  children,
  inspector,
  inspectorLabel = '上下文与高级信息',
}: WorkspaceLayoutProps) => {
  const [inspectorTab, setInspectorTab] = useState<'common' | 'versions' | 'tasks'>('common');
  return (
    <div className="guided-workspace">
      <aside aria-label="创作流程" className="workspace-flow">
        {flow}
      </aside>
      <section className="workspace-canvas">{children}</section>
      {inspector !== undefined && (
        <aside aria-label={inspectorLabel} className="workspace-inspector">
          <header className="inspector-header">
            <small>上下文检查器</small>
            <strong>{inspectorLabel}</strong>
          </header>
          <nav aria-label="检查器内容" className="inspector-tabs">
            {[
              ['common', '常用'],
              ['versions', '版本与锁'],
              ['tasks', '任务'],
            ].map(([value, label]) => (
              <button
                aria-pressed={inspectorTab === value}
                className={inspectorTab === value ? 'active' : ''}
                key={value}
                onClick={() => {
                  setInspectorTab(value as 'common' | 'versions' | 'tasks');
                }}
                type="button"
              >
                {label}
              </button>
            ))}
          </nav>
          {inspectorTab === 'common' ? (
            <div className="inspector-content">{inspector}</div>
          ) : (
            <section className="inspector-tab-placeholder">
              <h3>{inspectorTab === 'versions' ? '版本与锁' : '生成任务'}</h3>
              <p>
                {inspectorTab === 'versions'
                  ? '版本历史、锁定字段和恢复操作保留在当前对象中。'
                  : '当前阶段没有需要处理的生成任务。'}
              </p>
            </section>
          )}
        </aside>
      )}
    </div>
  );
};
