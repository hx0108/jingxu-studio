import type { ReactNode } from 'react';

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
}: WorkspaceLayoutProps) => (
  <div className="guided-workspace">
    <aside aria-label="创作流程" className="workspace-flow">
      {flow}
    </aside>
    <section className="workspace-canvas">{children}</section>
    {inspector !== undefined && (
      <aside aria-label={inspectorLabel} className="workspace-inspector">
        <details open>
          <summary>{inspectorLabel}</summary>
          <div className="inspector-content">{inspector}</div>
        </details>
      </aside>
    )}
  </div>
);
