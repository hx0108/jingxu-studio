import type { ReactNode } from 'react';

import { workspaceStatusLabel, workspaceStatusTone } from './workspace-status';

export const StatusBadge = ({ status }: { readonly status: string | null | undefined }) => (
  <span className={`status-pill status-pill-${workspaceStatusTone(status)}`}>
    <span aria-hidden="true" className="status-dot" />
    {workspaceStatusLabel(status)}
  </span>
);

export interface WorkspaceLayoutProps {
  readonly children: ReactNode;
  readonly inspector?: ReactNode;
  readonly inspectorLabel?: string;
}

export const WorkspaceLayout = ({
  children,
  inspector,
  inspectorLabel = '上下文与高级信息',
}: WorkspaceLayoutProps) => {
  return (
    <div className="guided-workspace approved-workspace-layout">
      <section className="workspace-canvas">{children}</section>
      {inspector !== undefined && (
        <aside aria-label={inspectorLabel} className="workspace-inspector">
          <div className="inspector-content">{inspector}</div>
        </aside>
      )}
    </div>
  );
};
